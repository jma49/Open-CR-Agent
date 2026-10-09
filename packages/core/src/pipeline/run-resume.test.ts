import { describe, expect, it } from "vitest";
import type { ReviewEvent } from "../report/report.js";
import type { ResumedRun } from "./resume.js";
import { finding, patch, runtime, twoFiles, vcs } from "./run.fakes.js";
import { reviewWithHooks } from "./run.js";

const usage = { inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cachedTokens: 0 };

// One task per file, without a grouping call.
const perFile = {
  bundling: { groupingMinFiles: 2, maxFilesPerBundle: 10, maxBundleChars: 120_000 },
  grouper: {
    group: async () => {
      throw new Error("no grouping in this test");
    },
  },
  relocate: false as const,
  stages: { verify: false, judge: false },
};

// Each task reports one finding on its file and costs $0.01; the tasks named
// in `refused` are refused for quota instead.
function reviewing(refused: readonly string[] = []) {
  return runtime(async function* (spec) {
    if (refused.includes(spec.taskId)) {
      yield { type: "error", taskId: spec.taskId, error: "quota exceeded", retryable: true };
      return;
    }
    const file = spec.taskId.endsWith("-1") ? "src/a.ts" : "src/b.ts";
    const code = file === "src/a.ts" ? "const a = 1;" : "const b = 2;";
    yield { type: "finding", taskId: spec.taskId, finding: finding(file, code) };
    yield { type: "usage", taskId: spec.taskId, ...usage, costUsd: 0.01 };
    yield { type: "done", taskId: spec.taskId };
  });
}

// What `ocra review --resume` reads back from the session log.
function resumedFrom(runId: string, events: readonly ReviewEvent[]): ResumedRun {
  const keys = new Map<string, Extract<ReviewEvent, { type: "task_reported" }>>();
  for (const e of events) if (e.type === "task_reported") keys.set(e.taskId, e);
  const run = events.find((e) => e.type === "run_finished");
  return {
    runId,
    bundles: run?.type === "run_finished" ? run.report.bundles : [],
    tasks: events.flatMap((e) => {
      const reported = e.type === "task_finished" ? keys.get(e.outcome.taskId) : undefined;
      if (e.type !== "task_finished" || !reported) return [];
      return [{ key: reported.key, outcome: e.outcome, findings: reported.findings }];
    }),
  };
}

async function firstRun(diff = twoFiles) {
  const events: ReviewEvent[] = [];
  const report = await reviewWithHooks({
    vcs: vcs({}, diff),
    runtime: reviewing(["correctness-2"]),
    identity: { runId: "first" },
    onEvent: (e) => events.push(e),
    ...perFile,
  });
  return { report, resume: resumedFrom("first", events) };
}

describe("resuming an earlier run", () => {
  it("runs only the tasks that did not complete and reuses the rest unpaid", async () => {
    const first = await firstRun();
    expect(first.report.tasks.map((t) => t.status)).toEqual(["completed", "failed"]);

    const rt = reviewing();
    const second = await reviewWithHooks({
      vcs: vcs({}, twoFiles),
      runtime: rt,
      resume: first.resume,
      ...perFile,
    });

    expect(rt.specs.map((s) => s.taskId)).toEqual(["correctness-2"]);
    expect(second.tasks.map((t) => [t.taskId, t.status, t.reusedFrom])).toEqual([
      ["correctness-1", "completed", "first"],
      ["correctness-2", "completed", undefined],
    ]);
    expect(second.findings.map((f) => f.file).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(second.coverage.map((c) => c.status)).toEqual(["reviewed", "reviewed"]);
    // The reused task keeps what it cost the earlier run; this run paid one task.
    expect(second.tasks[0]?.usage.costUsd).toBe(0.01);
    expect(second.usage.costUsd).toBe(0.01);
    expect(second.warnings.filter((w) => w.includes("resumed"))).toEqual([]);
  });

  it("reviews again a task cut off before it finished", async () => {
    const events: ReviewEvent[] = [];
    await reviewWithHooks({
      vcs: vcs({}, twoFiles),
      runtime: runtime(async function* (spec) {
        if (spec.taskId === "correctness-2") {
          yield { type: "error", taskId: spec.taskId, error: "quota exceeded", retryable: true };
          return;
        }
        yield { type: "done", taskId: spec.taskId, ended: "step_cap" };
      }),
      onEvent: (e) => events.push(e),
      ...perFile,
    });
    const rt = reviewing();
    const second = await reviewWithHooks({
      vcs: vcs({}, twoFiles),
      runtime: rt,
      resume: resumedFrom("first", events),
      ...perFile,
    });
    expect(rt.specs.map((s) => s.taskId)).toEqual(["correctness-1", "correctness-2"]);
    expect(second.coverage.map((c) => c.status)).toEqual(["reviewed", "reviewed"]);
  });

  it("names the run that paid for a task reused twice", async () => {
    const first = await firstRun();
    const events: ReviewEvent[] = [];
    await reviewWithHooks({
      vcs: vcs({}, twoFiles),
      runtime: reviewing(["correctness-2"]),
      resume: first.resume,
      onEvent: (e) => events.push(e),
      ...perFile,
    });
    const rt = reviewing();
    const third = await reviewWithHooks({
      vcs: vcs({}, twoFiles),
      runtime: rt,
      resume: resumedFrom("second", events),
      ...perFile,
    });
    expect(rt.specs.map((s) => s.taskId)).toEqual(["correctness-2"]);
    expect(third.tasks[0]?.reusedFrom).toBe("first");
  });

  it("reviews again a task whose inputs changed, and says so", async () => {
    const first = await firstRun();
    const changed = [patch("src/a.ts", "const a = 3;"), patch("src/b.ts", "const b = 2;")].join(
      "\n",
    );
    const rt = reviewing();
    const second = await reviewWithHooks({
      vcs: vcs({}, changed),
      runtime: rt,
      resume: first.resume,
      ...perFile,
    });
    expect(rt.specs.map((s) => s.taskId)).toEqual(["correctness-1", "correctness-2"]);
    expect(second.tasks.every((t) => t.reusedFrom === undefined)).toBe(true);
    expect(second.warnings).toContain(
      "resumed run first: 1 completed task(s) not reused, their inputs changed (commits, configuration, prompts or ocra version)",
    );
  });

  it("does not reuse a task made with another ocra build or sampling", async () => {
    const first = await firstRun();
    const rt = reviewing();
    await reviewWithHooks({
      vcs: vcs({}, twoFiles),
      runtime: rt,
      resume: first.resume,
      identity: { provenance: { ocraVersion: "9.9.9", configHash: "c" } },
      ...perFile,
    });
    expect(rt.specs).toHaveLength(2);
  });

  it("keeps the earlier bundles, so a grouping that would differ does not matter", async () => {
    const first = await firstRun();
    const rt = reviewing();
    const second = await reviewWithHooks({
      vcs: vcs({}, twoFiles),
      runtime: rt,
      resume: first.resume,
      ...perFile,
      // Bundled afresh, both files would be one task.
      bundling: { groupingMinFiles: 4, maxFilesPerBundle: 10, maxBundleChars: 120_000 },
    });
    expect(second.bundles).toEqual(first.report.bundles);
    expect(rt.specs.map((s) => s.taskId)).toEqual(["correctness-2"]);
  });
});
