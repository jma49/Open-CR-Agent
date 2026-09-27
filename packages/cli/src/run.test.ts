import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTaskSpec, OcraPlugin } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_PLUGINS, type ReviewDeps } from "./review/command.js";
import { run } from "./run.js";

function capture() {
  let text = "";
  return { write: (chunk: string) => (text += chunk), text: () => text };
}

const dirs: string[] = [];
const disposed = { count: 0 };
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWithChange(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-cli-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "app.ts"), "export const limit = 10;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "app.ts"), "export const limit = 10;\nexport const retries = -1;\n");
  return dir;
}

type Script = (spec: AgentTaskSpec) => AsyncIterable<AgentEvent>;

// With `verifier`, the fake runtime answers Verify by confirming every
// finding and the judge with no changes.
function deps(
  cwd: string,
  script: Script,
  extra: Partial<ReviewDeps> = {},
  verifier = false,
): ReviewDeps {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
  };
  const fakeRuntime: OcraPlugin = {
    name: "runtime-opencode",
    configure(ctx) {
      ctx.registerRuntime("opencode", () => ({
        name: "fake",
        runTask: (spec) => script(spec),
        ...(verifier
          ? {
              complete: async (request: { tier: string }) => ({
                text: request.tier === "top" ? "{}" : '[{"index":0,"verdict":"confirmed"}]',
                usage,
              }),
            }
          : {}),
        dispose: async () => {
          disposed.count += 1;
        },
      }));
    },
  };
  return {
    cwd,
    env: {},
    builtinPlugins: BUILTIN_PLUGINS.map((p) => (p.name === fakeRuntime.name ? fakeRuntime : p)),
    writeFile: async (path, content) => writeFileSync(path, content),
    now: Date.now,
    heartbeatMs: 60_000,
    ...extra,
  };
}

const critical: Script = async function* (spec) {
  yield {
    type: "finding",
    taskId: spec.taskId,
    finding: {
      category: "correctness",
      severity: "critical",
      file: "app.ts",
      existingCode: "export const retries = -1;",
      title: "Negative retry count disables retries",
      body: "The retry loop runs while attempts < retries, so -1 never retries.",
      evidence: [],
    },
  };
  yield { type: "done", taskId: spec.taskId };
};

describe("ocra", () => {
  it("prints the version and usage", async () => {
    const out = capture();
    expect(await run(["--version"], out, capture())).toBe(0);
    expect(out.text()).toBe("0.0.0\n");
    const usage = capture();
    expect(await run([], usage, capture())).toBe(0);
    expect(usage.text()).toContain("Usage: ocra");
  });

  it("rejects unknown commands and options", async () => {
    const err = capture();
    expect(await run(["nope"], capture(), err)).toBe(2);
    expect(err.text()).toContain("Unknown command: nope");
    expect(await run(["--nope"], capture(), capture())).toBe(2);
  });
});

describe("ocra review", () => {
  it("reviews the working tree, prints findings and exits 1 on verified critical findings", async () => {
    const cwd = repoWithChange();
    const out = capture();
    const err = capture();
    expect(await run(["review"], out, err, deps(cwd, critical, {}, true))).toBe(1);

    expect(out.text()).toContain(
      "app.ts\n  critical   L2        Negative retry count disables retries [verified]",
    );
    expect(err.text()).toContain("[ocra] Reviewing: Working tree changes");
    expect(err.text()).toContain("[ocra] correctness-1 completed in");

    expect(disposed.count).toBeGreaterThan(0);
    const sessions = readdirSync(join(cwd, ".ocra", "sessions")).filter((f) => f !== ".gitignore");
    expect(sessions).toHaveLength(1);
    // Untracked directories collapse to ".ocra/" unless every file is listed.
    expect(
      execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd,
        encoding: "utf8",
      }),
    ).not.toContain(".ocra/sessions");
    const sessionDir = join(cwd, ".ocra", "sessions", sessions[0] as string);
    expect(existsSync(join(sessionDir, "events.jsonl"))).toBe(true);
    expect(JSON.parse(readFileSync(join(sessionDir, "report.json"), "utf8")).findings).toHaveLength(
      1,
    );
  });

  it("exits 3 when a critical finding could not be verified", async () => {
    const cwd = repoWithChange();
    const out = capture();
    const err = capture();
    expect(await run(["review"], out, err, deps(cwd, critical))).toBe(3);
    expect(out.text()).toContain("Verdict: minor issues");
    expect(out.text()).toContain("[not verified]");
    expect(out.text()).toContain(
      "Incomplete: verification failed or ran out of budget for 1 critical finding(s)",
    );
    expect(err.text()).toContain("1 critical finding(s) could not be verified");
  });

  it("exits 0 with unverified critical findings when verification is turned off", async () => {
    const cwd = repoWithChange();
    mkdirSync(join(cwd, ".ocra"), { recursive: true });
    writeFileSync(join(cwd, ".ocra", "config.json"), '{"verify": false}');
    const out = capture();
    expect(await run(["review"], out, capture(), deps(cwd, critical))).toBe(0);
    expect(out.text()).toContain(
      "1 critical finding(s) are not verified, so the verdict is at most minor issues.",
    );
    expect(out.text()).not.toContain("Incomplete:");
  });

  it("writes JSON to a file and exits 0 without critical findings", async () => {
    const cwd = repoWithChange();
    const clean: Script = async function* (spec) {
      yield { type: "done", taskId: spec.taskId };
    };
    const out = capture();
    expect(
      await run(
        ["review", "--format", "json", "--output", "r.json"],
        out,
        capture(),
        deps(cwd, clean),
      ),
    ).toBe(0);
    expect(out.text()).toBe("");
    expect(JSON.parse(readFileSync(join(cwd, "r.json"), "utf8"))).toMatchObject({
      findings: [],
      tier: "trivial",
    });
  });

  it("exits 2 when no review task completes", async () => {
    const cwd = repoWithChange();
    const broken: Script = async function* () {
      yield* [];
      throw new Error("OpenCodeRuntime.runTask is not implemented yet");
    };
    const err = capture();
    expect(await run(["review"], capture(), err, deps(cwd, broken))).toBe(2);
    expect(err.text()).toContain("correctness-1 failed");
    expect(err.text()).toContain("No review task completed");
  });

  it("reports usage errors, git errors and config errors with exit 2", async () => {
    const cwd = repoWithChange();
    const usage = capture();
    expect(await run(["review", "--to", "x"], capture(), usage, deps(cwd, critical))).toBe(2);
    expect(usage.text()).toContain("--to requires --from");

    const git = capture();
    expect(await run(["review", "--commit", "nope"], capture(), git, deps(cwd, critical))).toBe(2);
    expect(git.text()).toBe("ocra: Unknown commit: nope\n");

    mkdirSync(join(cwd, ".ocra"), { recursive: true });
    writeFileSync(join(cwd, ".ocra", "config.json"), '{"concurrency": "high"}');
    const config = capture();
    expect(await run(["review"], capture(), config, deps(cwd, critical))).toBe(2);
    expect(config.text()).toContain("ocra: .ocra/config.json is invalid");
  });

  it("loads external plugins from the repository config", async () => {
    const cwd = repoWithChange();
    mkdirSync(join(cwd, ".ocra"), { recursive: true });
    writeFileSync(
      join(cwd, ".ocra", "team-rules.mjs"),
      'export default { name: "team-rules", configure(ctx) { ctx.registerRules([{ path: "**/*.ts", rule: "Retries must be positive (" + ctx.settings.owner + ")." }]); } };\n',
    );
    writeFileSync(
      join(cwd, ".ocra", "config.json"),
      JSON.stringify({
        plugins: ["./.ocra/team-rules.mjs"],
        pluginSettings: { "team-rules": { owner: "platform" } },
      }),
    );
    const prompts: string[] = [];
    const recordPrompts: Script = async function* (spec) {
      prompts.push(spec.userPrompt);
      yield { type: "done", taskId: spec.taskId };
    };
    expect(await run(["review"], capture(), capture(), deps(cwd, recordPrompts))).toBe(0);
    expect(prompts.some((p) => p.includes("Retries must be positive (platform)."))).toBe(true);
  });

  it("never imports repository plugins with --no-repo-config", async () => {
    const cwd = repoWithChange();
    const marker = join(cwd, "plugin-ran");
    mkdirSync(join(cwd, ".ocra"), { recursive: true });
    writeFileSync(
      join(cwd, ".ocra", "evil.mjs"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x"); export default { name: "evil" };\n`,
    );
    writeFileSync(
      join(cwd, ".ocra", "config.json"),
      JSON.stringify({ plugins: ["./.ocra/evil.mjs"] }),
    );
    expect(
      await run(
        ["review", "--no-repo-config"],
        capture(),
        capture(),
        deps(cwd, critical, {}, true),
      ),
    ).toBe(1);
    expect(existsSync(marker)).toBe(false);
  });

  it("runs only the reviewers named with --reviewers", async () => {
    const cwd = repoWithChange();
    const reviewers: string[] = [];
    const record: Script = async function* (spec) {
      reviewers.push(spec.reviewer);
      yield { type: "done", taskId: spec.taskId };
    };
    expect(
      await run(["review", "--reviewers", "correctness"], capture(), capture(), deps(cwd, record)),
    ).toBe(0);
    expect(reviewers).toEqual(["correctness"]);

    const err = capture();
    expect(await run(["review", "--reviewers", "nope"], capture(), err, deps(cwd, record))).toBe(2);
    expect(err.text()).toContain("Unknown reviewer(s): nope");
  });

  it("exits 3 when no reviewer covers a selected file", async () => {
    const cwd = repoWithChange();
    const out = capture();
    const err = capture();
    // performance starts at the lite tier; this change is trivial.
    expect(await run(["review", "--reviewers", "performance"], out, err, deps(cwd, critical))).toBe(
      3,
    );
    expect(out.text()).toContain("Verdict: not reached (nothing was reviewed)");
    expect(err.text()).toContain("1 selected file(s) were not reviewed");
    expect(err.text()).not.toContain("Verdict: approved");
  });

  it("exits 3 when some review tasks did not finish", async () => {
    const cwd = repoWithChange();
    writeFileSync(join(cwd, "other.ts"), "export const other = 1;\n");
    writeFileSync(join(cwd, "third.ts"), "export const third = 1;\n");
    writeFileSync(join(cwd, "fourth.ts"), "export const fourth = 1;\n");
    const halfFails: Script = async function* (spec) {
      if (spec.taskId.endsWith("-1"))
        yield { type: "error", taskId: spec.taskId, error: "overloaded", retryable: true };
      else yield { type: "done", taskId: spec.taskId };
    };
    const err = capture();
    expect(await run(["review"], capture(), err, deps(cwd, halfFails))).toBe(3);
  });

  it("stops on Ctrl-C with a partial report, cleans up and exits 130", async () => {
    const cwd = repoWithChange();
    let interrupt = () => {};
    let listening = false;
    const waitsForCtrlC: Script = async function* (spec) {
      interrupt();
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield { type: "done", taskId: spec.taskId };
    };
    const before = disposed.count;
    const out = capture();
    const err = capture();
    const code = await run(
      ["review"],
      out,
      err,
      deps(cwd, waitsForCtrlC, {
        onInterrupt(handler) {
          interrupt = handler;
          listening = true;
          return () => {
            listening = false;
          };
        },
      }),
    );
    expect(code).toBe(130);
    expect(err.text()).toContain("Interrupted: stopping and writing a partial report");
    expect(out.text()).toContain("Review: Working tree changes");
    expect(disposed.count).toBeGreaterThan(before);
    expect(listening).toBe(false);
  });

  it("previews the review with --plan without creating a runtime", async () => {
    const cwd = repoWithChange();
    writeFileSync(join(cwd, "yarn.lock"), "lock\n");
    const refuseRuntime: OcraPlugin = {
      name: "runtime-opencode",
      configure(ctx) {
        ctx.registerRuntime("opencode", () => {
          throw new Error("--plan must not start a runtime");
        });
      },
    };
    const out = capture();
    const code = await run(["review", "--plan"], out, capture(), {
      ...deps(cwd, critical),
      builtinPlugins: BUILTIN_PLUGINS.map((p) =>
        p.name === refuseRuntime.name ? refuseRuntime : p,
      ),
    });
    expect(code).toBe(0);
    expect(out.text()).toContain("Plan: Working tree changes");
    expect(out.text()).toContain("yarn.lock  (generated)");
    expect(out.text()).toMatch(/correctness-1 +~[\d,]+ prompt tokens/);
    expect(out.text()).toContain("No model was called.");

    const json = capture();
    await run(["review", "--plan", "--format", "json"], json, capture(), deps(cwd, critical));
    expect(JSON.parse(json.text())).toMatchObject({ tier: "trivial", selected: ["app.ts"] });
  });

  it("reports missing or invalid external plugins", async () => {
    const cwd = repoWithChange();
    mkdirSync(join(cwd, ".ocra"), { recursive: true });
    writeFileSync(
      join(cwd, ".ocra", "config.json"),
      JSON.stringify({ plugins: ["ocra-plugin-missing"] }),
    );
    const missing = capture();
    expect(await run(["review"], capture(), missing, deps(cwd, critical))).toBe(2);
    expect(missing.text()).toContain('Cannot find plugin "ocra-plugin-missing"');

    writeFileSync(join(cwd, ".ocra", "bad.mjs"), "export const nothing = 1;\n");
    writeFileSync(
      join(cwd, ".ocra", "config.json"),
      JSON.stringify({ plugins: ["./.ocra/bad.mjs"] }),
    );
    const invalid = capture();
    expect(await run(["review"], capture(), invalid, deps(cwd, critical))).toBe(2);
    expect(invalid.text()).toContain('Plugin "./.ocra/bad.mjs" must export an ocra plugin');
  });

  it("prints review help", async () => {
    const out = capture();
    expect(await run(["review", "--help"], out, capture(), deps(".", critical))).toBe(0);
    expect(out.text()).toContain("Usage: ocra review [options]");
  });
});
