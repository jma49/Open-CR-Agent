import { appendFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finding, runtime, twoFiles, vcs } from "../pipeline/run.fakes.js";
import { reviewWithHooks } from "../pipeline/run.js";
import { EVENTS_FILE, JsonlSessionWriter } from "./jsonl.js";
import { readResumedRun } from "./resume-read.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A review logged to a session as the CLI does; task -2 is refused for quota.
async function loggedRun(id: string, finish = true): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "ocra-resume-"));
  dirs.push(root);
  const writer = new JsonlSessionWriter(root, id);
  await reviewWithHooks({
    vcs: vcs({}, twoFiles),
    runtime: runtime(async function* (spec) {
      if (spec.taskId.endsWith("-2")) {
        yield { type: "error", taskId: spec.taskId, error: "quota exceeded", retryable: true };
        return;
      }
      yield { type: "finding", taskId: spec.taskId, finding: finding("src/a.ts", "const a = 1;") };
      yield { type: "done", taskId: spec.taskId };
    }),
    identity: { runId: id },
    bundling: { groupingMinFiles: 2, maxFilesPerBundle: 10, maxBundleChars: 120_000 },
    grouper: {
      group: async () => {
        throw new Error("no grouping");
      },
    },
    relocate: false,
    stages: { verify: false, judge: false },
    onEvent: (e) => {
      if (finish || e.type !== "run_finished") writer.write(e);
    },
  });
  return root;
}

describe("readResumedRun", () => {
  it("reads back the completed tasks, their findings and the bundles", async () => {
    const root = await loggedRun("r1");
    const run = await readResumedRun(root, "r1");
    expect(run.runId).toBe("r1");
    expect(run.bundles.map((b) => b.files)).toEqual([["src/a.ts"], ["src/b.ts"]]);
    expect(run.tasks.map((t) => t.outcome.taskId)).toEqual(["correctness-1"]);
    expect(run.tasks[0]?.key).toMatch(/\S/);
    expect(run.tasks[0]?.findings.map((f) => f.reported.file)).toEqual(["src/a.ts"]);
  });

  it("skips lines that are not valid task events", async () => {
    const root = await loggedRun("r3");
    const log = join(root, "r3", EVENTS_FILE);
    const forged = {
      type: "task_reported",
      taskId: "correctness-9",
      key: "k",
      findings: [{ reported: { file: "x.ts" } }],
    };
    appendFileSync(log, `not json\n${JSON.stringify(forged)}\n`);
    appendFileSync(
      log,
      `${JSON.stringify({ type: "task_finished", outcome: { taskId: "correctness-9", status: "completed" } })}\n`,
    );
    const run = await readResumedRun(root, "r3");
    expect(run.tasks.map((t) => t.outcome.taskId)).toEqual(["correctness-1"]);
  });

  it("reads the tasks and bundles of a run killed before its report", async () => {
    const root = await loggedRun("r5", false);
    const run = await readResumedRun(root, "r5");
    expect(run.bundles.map((b) => b.files)).toEqual([["src/a.ts"], ["src/b.ts"]]);
    expect(run.tasks).toHaveLength(1);
  });

  it("bounds what a hand-written session brings in, as a live task's findings are", async () => {
    const root = await loggedRun("r6");
    const log = join(root, "r6", EVENTS_FILE);
    const big = finding("src/a.ts", "const a = 1;", { title: "x".repeat(5000) });
    const forged = {
      type: "task_reported",
      taskId: "correctness-1",
      key: "k",
      findings: Array.from({ length: 80 }, () => ({ reported: big })),
    };
    appendFileSync(log, `${JSON.stringify(forged)}\n`);
    const [task] = (await readResumedRun(root, "r6")).tasks;
    expect(task?.findings).toHaveLength(50);
    expect(task?.findings[0]?.reported.title.length).toBeLessThan(5000);
  });

  it("refuses a session that is a symbolic link", async () => {
    const root = await loggedRun("r7");
    symlinkSync(join(root, "r7"), join(root, "linked"));
    await expect(readResumedRun(root, "linked")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("refuses a run id that is a path, and a run without a session", async () => {
    const root = await loggedRun("r4");
    await expect(readResumedRun(root, "../r4")).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(readResumedRun(root, ".")).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(readResumedRun(root, "missing")).rejects.toThrow(/no session log for run missing/);
  });
});
