import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finding, runtime, twoFiles, vcs } from "../pipeline/run.fakes.js";
import { reviewWithHooks } from "../pipeline/run.js";
import type { ReviewEvent } from "../report/report.js";
import { EVENTS_FILE, JsonlSessionWriter, REPORT_FILE } from "./jsonl.js";
import { readResumedRun } from "./resume-read.js";

// This machine's key, and another's.
const KEY = "ab".repeat(32);
const OTHER = "cd".repeat(32);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// A review logged to a session as the CLI does; task -2 is refused for quota.
async function loggedRun(id: string, finish = true) {
  const root = tempDir("ocra-resume-");
  const writer = new JsonlSessionWriter(root, id, KEY);
  const events: ReviewEvent[] = [];
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
      events.push(e);
      if (finish || e.type !== "run_finished") writer.write(e);
    },
  });
  return { root, events };
}

// The completed task's two events, as if task -2 had completed too.
function asSecondTask(
  events: readonly ReviewEvent[],
  outcome: Record<string, unknown> = {},
): ReviewEvent[] {
  const reported = events.find((e) => e.type === "task_reported");
  const finished = events.find(
    (e) => e.type === "task_finished" && e.outcome.taskId === "correctness-1",
  );
  if (reported?.type !== "task_reported" || finished?.type !== "task_finished") {
    throw new Error("the logged run has no completed task");
  }
  return [
    { ...reported, taskId: "correctness-2" },
    {
      type: "task_finished",
      outcome: { ...finished.outcome, taskId: "correctness-2", ...outcome },
    },
  ];
}

function line(event: ReviewEvent): string {
  return `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`;
}

describe("readResumedRun", () => {
  it("reads back the completed tasks, their findings and the bundles", async () => {
    const { root } = await loggedRun("r1");
    const run = await readResumedRun(root, "r1", KEY);
    expect(run.runId).toBe("r1");
    expect(run.bundles.map((b) => b.files)).toEqual([["src/a.ts"], ["src/b.ts"]]);
    expect(run.tasks.map((t) => t.outcome.taskId)).toEqual(["correctness-1"]);
    expect(run.tasks[0]?.key).toMatch(/\S/);
    expect(run.tasks[0]?.findings.map((f) => f.reported.file)).toEqual(["src/a.ts"]);
  });

  it("skips lines that are not valid task events", async () => {
    const { root } = await loggedRun("r3");
    const writer = new JsonlSessionWriter(root, "r3", KEY);
    const forged = {
      type: "task_reported",
      taskId: "correctness-9",
      key: "k",
      findings: [{ reported: { file: "x.ts" } }],
    };
    writer.write(forged as unknown as ReviewEvent);
    writer.write({
      type: "task_finished",
      outcome: { taskId: "correctness-9", status: "completed" },
    } as unknown as ReviewEvent);
    appendFileSync(join(root, "r3", EVENTS_FILE), "not json\n");
    const run = await readResumedRun(root, "r3", KEY);
    expect(run.tasks.map((t) => t.outcome.taskId)).toEqual(["correctness-1"]);
  });

  it("reads the tasks and bundles of a run killed before its report", async () => {
    const { root } = await loggedRun("r5", false);
    const run = await readResumedRun(root, "r5", KEY);
    expect(run.bundles.map((b) => b.files)).toEqual([["src/a.ts"], ["src/b.ts"]]);
    expect(run.tasks).toHaveLength(1);
  });

  it("bounds the findings a session brings in, as a live task's findings are", async () => {
    const { root } = await loggedRun("r6");
    const big = finding("src/a.ts", "const a = 1;", { title: "x".repeat(5000) });
    new JsonlSessionWriter(root, "r6", KEY).write({
      type: "task_reported",
      taskId: "correctness-1",
      key: "k",
      findings: Array.from({ length: 80 }, () => ({ reported: big })),
    });
    const [task] = (await readResumedRun(root, "r6", KEY)).tasks;
    expect(task?.findings).toHaveLength(50);
    expect(task?.findings[0]?.reported.title.length).toBeLessThan(5000);
  });

  it("refuses a run id that is a path, and a run without a session", async () => {
    const { root } = await loggedRun("r4");
    await expect(readResumedRun(root, "../r4", KEY)).rejects.toMatchObject({
      code: "INPUT_INVALID",
    });
    await expect(readResumedRun(root, ".", KEY)).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(readResumedRun(root, "missing", KEY)).rejects.toThrow(
      /no session log for run missing/,
    );
  });

  it("says a session log with no line in it is empty", async () => {
    const { root } = await loggedRun("r5");
    writeFileSync(join(root, "r5", EVENTS_FILE), "\n");
    await expect(readResumedRun(root, "r5", KEY)).rejects.toThrow(
      /session log of r5 is empty, so there is nothing to reuse/,
    );
  });
});

// The session lives in the reviewed tree, so a change can bring one of its
// own: only what ocra wrote on this machine is read back as results.
describe("readResumedRun on a session it did not write", () => {
  it("refuses a session sealed with another key", async () => {
    const { root } = await loggedRun("s1");
    await expect(readResumedRun(root, "s1", OTHER)).rejects.toMatchObject({
      code: "INPUT_INVALID",
      message: expect.stringContaining("not written by ocra on this machine"),
    });
  });

  it("ignores well-formed task events added to the log without this machine's seal", async () => {
    const { root, events } = await loggedRun("s2");
    appendFileSync(join(root, "s2", EVENTS_FILE), asSecondTask(events).map(line).join(""));
    const warnings: string[] = [];
    const run = await readResumedRun(root, "s2", KEY, (w) => warnings.push(w));
    expect(run.tasks.map((t) => t.outcome.taskId)).toEqual(["correctness-1"]);
    expect(warnings).toEqual([
      "--resume: ignored 2 line(s) of the session of s2 that ocra on this machine did not write",
    ]);
  });

  it("ignores events sealed for another run", async () => {
    const { root, events } = await loggedRun("s3");
    const other = new JsonlSessionWriter(root, "s3-other", KEY);
    for (const event of asSecondTask(events)) other.write(event);
    appendFileSync(
      join(root, "s3", EVENTS_FILE),
      readFileSync(join(root, "s3-other", EVENTS_FILE), "utf8"),
    );
    const run = await readResumedRun(root, "s3", KEY);
    expect(run.tasks.map((t) => t.outcome.taskId)).toEqual(["correctness-1"]);
  });

  it("takes the bundles from the sealed log, not from report.json", async () => {
    const { root } = await loggedRun("s4");
    const path = join(root, "s4", REPORT_FILE);
    const report = JSON.parse(readFileSync(path, "utf8"));
    report.bundles = [{ label: "all", files: ["src/a.ts", "src/b.ts"] }];
    writeFileSync(path, JSON.stringify(report));
    const run = await readResumedRun(root, "s4", KEY);
    expect(run.bundles.map((b) => b.files)).toEqual([["src/a.ts"], ["src/b.ts"]]);
  });

  it("does not reuse a task whose earlier run is not named by a run id", async () => {
    const { root, events } = await loggedRun("s5");
    const writer = new JsonlSessionWriter(root, "s5", KEY);
    for (const event of asSecondTask(events, { reusedFrom: "not a run id\u001b[2J" })) {
      writer.write(event);
    }
    const run = await readResumedRun(root, "s5", KEY);
    expect(run.tasks.map((t) => t.outcome.taskId)).toEqual(["correctness-1"]);
  });

  it("refuses a session log that is a symbolic link, without reading its target", async () => {
    const { root } = await loggedRun("s6");
    const elsewhere = tempDir("ocra-elsewhere-");
    const log = join(root, "s6", EVENTS_FILE);
    renameSync(log, join(elsewhere, EVENTS_FILE));
    symlinkSync(join(elsewhere, EVENTS_FILE), log);
    await expect(readResumedRun(root, "s6", KEY)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
  });

  it("refuses a session reached through a linked directory", async () => {
    const { root } = await loggedRun("s7");
    symlinkSync(join(root, "s7"), join(root, "linked"));
    await expect(readResumedRun(root, "linked", KEY)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    const tree = tempDir("ocra-tree-");
    mkdirSync(join(tree, ".ocra"));
    symlinkSync(root, join(tree, ".ocra", "sessions"));
    await expect(readResumedRun(join(tree, ".ocra", "sessions"), "s7", KEY)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
  });

  it("refuses a session log that is not a regular file", async () => {
    const { root } = await loggedRun("s8");
    const log = join(root, "s8", EVENTS_FILE);
    rmSync(log);
    mkdirSync(log);
    await expect(readResumedRun(root, "s8", KEY)).rejects.toMatchObject({
      code: "INPUT_INVALID",
      message: expect.stringContaining("not a regular file"),
    });
  });
});
