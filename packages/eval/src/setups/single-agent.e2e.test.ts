import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { exec } from "../exec.js";
import { defaultOcraCommand } from "../reviewer.js";
import { prepareSetup } from "./setup-config.js";

// The real CLI loads the built plugin, so this needs the build; tsc -b is
// incremental.
beforeAll(() => {
  const root = fileURLToPath(new URL("../../../..", import.meta.url));
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-b"], {
    cwd: root,
  });
}, 120_000);

const repos = scratchRepos("ocra-single-agent-");
const runDirs: string[] = [];
afterEach(() => {
  repos.removeAll();
  for (const dir of runDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("--setup single-agent", () => {
  it("plans one single-agent task and nothing from the built-in reviewers", async () => {
    const repo = repos.create();
    repo.commit("chore: start", { "app.ts": "export const a = 1;\n" });
    repo.commit("feat: f", {
      "app.ts": "export const a = 1;\nexport const f = (x: number[]) => x[0].toFixed();\n",
    });
    const runDir = mkdtempSync(join(tmpdir(), "ocra-single-agent-run-"));
    runDirs.push(runDir);
    const user = join(runDir, "user.json");
    writeFileSync(user, JSON.stringify({ models: { top: ["anthropic/claude-opus-5-5"] } }));
    const setup = await prepareSetup("single-agent", user, runDir);
    const [bin, ...prefix] = defaultOcraCommand();
    const result = await exec(
      bin as string,
      [
        ...prefix,
        "review",
        "--plan",
        "--from",
        "HEAD~1",
        "--to",
        "HEAD",
        "--no-repo-config",
        "--config",
        setup.configFile,
        ...setup.reviewArgs,
      ],
      { cwd: repo.dir, env: { PATH: process.env.PATH ?? "", HOME: repo.dir } },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(
      /Review tasks: 1\n\s+single-agent-1 .*anthropic\/claude-opus-5-5/,
    );
    expect(result.stdout).toContain("correctness on app.ts (disabled)");
    expect(result.stdout).toMatch(/verify\s+false/);
    expect(result.stdout).toMatch(/judge\s+false/);
  });
});
