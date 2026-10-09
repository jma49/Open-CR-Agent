import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { capture, deps } from "../run.fakes.js";
import { run } from "../run.js";

const repos = scratchRepos("ocra-init-");
afterEach(repos.removeAll);

const CONFIG = ".ocra/config.json";
const WORKFLOW = ".github/workflows/ocra.yml";

async function init(dir: string, args: string[], env: Record<string, string> = {}) {
  const out = capture();
  const err = capture();
  const none = async function* () {};
  const code = await run(["init", ...args], out, err, deps(dir, none, { env }));
  return { code, out: out.text(), err: err.text() };
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

describe("ocra init", () => {
  it("writes the configuration for the key it finds, at the repository's root", async () => {
    const { dir } = repos.create();
    mkdirSync(join(dir, "src"));
    const result = await init(join(dir, "src"), [], {
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENROUTER_API_KEY: "sk-or-secret",
    });
    expect(result).toEqual({
      code: 0,
      err: "",
      out: `Wrote .ocra/config.json: Anthropic models through ANTHROPIC_API_KEY, on the OpenCode runtime.
  Also found OPENROUTER_API_KEY; --provider picks another.
  OpenCode makes the install about 175 MB; to switch to the 11 MB direct runtime later, see https://github.com/jma49/Open-CR-Agent/blob/main/docs/manual/en/providers.mdx#choosing-the-runtime

Next:
  ocra review --plan    what a review would cover, without a model call
  ocra review           review your uncommitted changes
`,
    });
    const config = JSON.parse(read(dir, CONFIG));
    expect(config.runtime).toBeUndefined();
    expect(config.models.standard).toBe("anthropic/claude-sonnet-5-5");
    expect(read(dir, CONFIG)).not.toContain("secret");
    expect(existsSync(join(dir, WORKFLOW))).toBe(false);
  });

  it("uses OpenRouter's free router only without another key, and says what it is", async () => {
    const { dir } = repos.create();
    const result = await init(dir, [], { OPENROUTER_API_KEY: "sk-or-secret" });
    expect(result.out).toContain(
      "Wrote .ocra/config.json: OpenRouter's free router through OPENROUTER_API_KEY, on the direct runtime.\n" +
        "  The router picks among OpenRouter's free models, so quality varies: good for trying ocra, not for code you must keep private.\n" +
        "  Without credits on the account, OpenRouter allows few free requests a day; a large review may stop part way.\n",
    );
    expect(result.out).not.toContain("175 MB");
    const config = JSON.parse(read(dir, CONFIG));
    expect(config.runtime).toBe("direct");
    expect(config.models.top).toBe("router/openrouter/free");
  });

  it("keeps an existing configuration unless --force is given", async () => {
    const { dir } = repos.create();
    mkdirSync(join(dir, ".ocra"));
    writeFileSync(join(dir, CONFIG), '{ "models": {} }\n');
    const kept = await init(dir, [], { GEMINI_API_KEY: "g" });
    expect(kept).toEqual({
      code: 0,
      err: "",
      out: "Kept .ocra/config.json: it exists (--force replaces it).\n",
    });
    expect(read(dir, CONFIG)).toBe('{ "models": {} }\n');

    const forced = await init(dir, ["--force"], { GEMINI_API_KEY: "g" });
    expect(forced.out).toMatch(/^Wrote \.ocra\/config\.json: Gemini models/);
    expect(JSON.parse(read(dir, CONFIG)).models.top).toBe("google/gemini-3.1-pro-preview");
  });

  it("writes the fork-safe workflow with --github and says what to run next", async () => {
    const { dir } = repos.create();
    const result = await init(dir, ["--github"], { GEMINI_API_KEY: "g" });
    expect(result).toEqual({
      code: 0,
      err: "",
      out: `Wrote .ocra/config.json: Gemini models through GEMINI_API_KEY, on the OpenCode runtime.
  OpenCode makes the install about 175 MB; to switch to the 11 MB direct runtime later, see https://github.com/jma49/Open-CR-Agent/blob/main/docs/manual/en/providers.mdx#choosing-the-runtime
Wrote .github/workflows/ocra.yml: pull requests from members are reviewed on every push, anyone else's once each time a maintainer adds the ocra-review label.

Next:
  1. Store the key as a repository secret (gh asks for its value):
       gh secret set GEMINI_API_KEY
  2. Create the label that starts a review of an outside pull request:
       gh label create ocra-review --description "Review this pull request with ocra"
  3. Commit .ocra/config.json and .github/workflows/ocra.yml, and merge them into the default branch:
       ocra reads its configuration from a pull request's base branch.
`,
    });
    const workflow = read(dir, WORKFLOW);
    expect(workflow).toContain("pull_request_target:");
    // Gemini runs on OpenCode, so the Action installs it.
    expect(workflow).not.toContain("opencode:");
    expect(workflow).toContain(`GEMINI_API_KEY: \${{ secrets.GEMINI_API_KEY }}`);
  });

  it("leaves OpenCode out of the workflow for OpenRouter's free model, on the direct runtime", async () => {
    const { dir } = repos.create();
    const result = await init(dir, ["--github"], { OPENROUTER_API_KEY: "sk-or-secret" });
    expect(result.code).toBe(0);
    const workflow = read(dir, WORKFLOW);
    expect(workflow).toContain("          opencode: false\n");
    expect(workflow).toContain(`OPENROUTER_API_KEY: \${{ secrets.OPENROUTER_API_KEY }}`);
    expect(workflow).not.toContain("sk-or-secret");
  });

  it("writes the pull_request workflow with --same-repo-only, and no label step", async () => {
    const { dir } = repos.create();
    const result = await init(dir, ["--github", "--same-repo-only", "--provider", "openai"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Wrote .github/workflows/ocra.yml: pull requests from this repository's branches are reviewed; those from forks get no secrets and are skipped.\n",
    );
    expect(result.out).toContain("gh secret set OPENAI_API_KEY\n");
    expect(result.out).not.toContain("gh label");
    expect(read(dir, WORKFLOW)).toMatch(/^on: pull_request$/m);
  });

  it("keeps an existing workflow, and fits a new one to a configuration it kept", async () => {
    const { dir } = repos.create();
    mkdirSync(join(dir, ".ocra"));
    writeFileSync(join(dir, CONFIG), '{ "models": { "standard": "google/gemini-3.5-flash" } }\n');
    const first = await init(dir, ["--github"], { GEMINI_API_KEY: "g" });
    expect(first.out).toContain("Kept .ocra/config.json: it exists (--force replaces it).\n");
    expect(first.out).toContain(
      "  It passes GEMINI_API_KEY to the review: check that .ocra/config.json uses it.\n",
    );
    // That configuration runs on OpenCode, so the install keeps it.
    expect(read(dir, WORKFLOW)).not.toContain("opencode:");

    writeFileSync(join(dir, WORKFLOW), "name: mine\n");
    const second = await init(dir, ["--github", "--same-repo-only"], { GEMINI_API_KEY: "g" });
    expect(second.out).toBe(
      "Kept .ocra/config.json: it exists (--force replaces it).\nKept .github/workflows/ocra.yml: it exists (--force replaces it).\n",
    );
    expect(read(dir, WORKFLOW)).toBe("name: mine\n");
  });

  it("writes nothing without a key or with a bad option", async () => {
    const { dir } = repos.create();
    const none = await init(dir, ["--github"]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("No model key in the environment");
    expect(none.err).toContain("Usage: ocra init");
    const alone = await init(dir, ["--same-repo-only"], { GEMINI_API_KEY: "g" });
    expect(alone.err).toContain("--same-repo-only goes with --github");
    const unknown = await init(dir, ["--yes"], { GEMINI_API_KEY: "g" });
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("Usage: ocra init");
    expect(existsSync(join(dir, ".ocra"))).toBe(false);
    expect(existsSync(join(dir, ".github"))).toBe(false);
  });

  it("refuses to write through a symbolic link on the way", async () => {
    const { dir } = repos.create();
    const outside = mkdtempSync(join(tmpdir(), "ocra-init-outside-"));
    try {
      symlinkSync(outside, join(dir, ".github"));
      const result = await init(dir, ["--github"], { GEMINI_API_KEY: "g" });
      expect(result.code).toBe(2);
      expect(result.err).toContain("Refusing to write through the symbolic link");
      expect(existsSync(join(outside, "workflows"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("stops outside a git repository", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ocra-init-nogit-"));
    try {
      const result = await init(outside, [], { GEMINI_API_KEY: "g" });
      expect(result.code).toBe(2);
      expect(existsSync(join(outside, ".ocra"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  const actionlint = (() => {
    try {
      execFileSync("actionlint", ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!actionlint)("writes workflows actionlint accepts", async () => {
    for (const args of [["--github"], ["--github", "--same-repo-only"]]) {
      const { dir } = repos.create();
      await init(dir, args, { GEMINI_API_KEY: "g" });
      expect(() => execFileSync("actionlint", [join(dir, WORKFLOW)])).not.toThrow();
    }
  });
});
