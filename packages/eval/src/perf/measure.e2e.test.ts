import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { defaultOcraCommand } from "../reviewer.js";
import { overBudget, perfBudgetSchema } from "./budget.js";
import { gitProcesses, measureReview } from "./measure.js";
import { syntheticChange } from "./synthetic-repo.fakes.js";

const root = fileURLToPath(new URL("../../../..", import.meta.url));

// The real CLI as a black box, so it needs the build; tsc -b is incremental.
beforeAll(() => {
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-b"], {
    cwd: root,
  });
}, 120_000);

const scratch = scratchRepos("ocra-perf-");
const outDirs: string[] = [];
afterEach(async () => {
  await scratch.removeAll();
  for (const dir of outDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("measureReview", () => {
  it("reviews the synthetic change within evals/perf-budget.json", async () => {
    const repo = scratch.create();
    const outDir = mkdtempSync(join(tmpdir(), "ocra-perf-out-"));
    outDirs.push(outDir);
    const result = await measureReview({
      repoDir: repo.dir,
      ...syntheticChange(repo),
      outDir,
      command: defaultOcraCommand(),
    });

    // Every stage ran: a prompt the scripted model no longer reads would
    // make the review cheaper, not dearer.
    expect(result.review).toMatchObject({ files: 16, tasks: result.review.findings });
    expect(result.review.tasks).toBeGreaterThan(0);
    const { byKind } = result.model;
    expect(byKind.grouping?.requests).toBe(1);
    expect(byKind.verify?.requests).toBeGreaterThan(0);
    expect(byKind.judge?.requests).toBe(1);
    expect(byKind.other?.requests).toBe(0);

    const budget = perfBudgetSchema.parse(
      JSON.parse(readFileSync(join(root, "evals/perf-budget.json"), "utf8")),
    );
    expect(overBudget(result, budget)).toEqual([]);
  }, 120_000);
});

describe("gitProcesses", () => {
  it("counts the commands of a git trace", () => {
    const trace = [
      "01:39:39.728557 git.c:463               trace: built-in: git rev-parse --show-toplevel",
      "01:39:39.753285 git.c:463               trace: built-in: git grep -n -z -e x",
      "01:39:39.756655 git.c:463               trace: built-in: git grep -n -z -e y",
      "01:39:39.760000 run-command.c:659       trace: run_command: unset GIT_PREFIX",
    ].join("\n");
    expect(gitProcesses(trace)).toEqual({ processes: 3, byCommand: { "rev-parse": 1, grep: 2 } });
  });
});
