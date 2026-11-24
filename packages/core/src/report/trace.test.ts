import { describe, expect, it } from "vitest";
import type { Usage } from "../contracts.js";
import type { Finding } from "../domain.js";
import type { TaskOutcome } from "./report.js";
import { TraceRecorder } from "./trace.js";

const usage: Usage = {
  inputTokens: 5,
  outputTokens: 2,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd: 0.001,
};

function finding(fingerprint: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id: `id-${fingerprint}`,
    fingerprint,
    reviewer: "correctness",
    category: "correctness",
    severity: "warning",
    file: "a.ts",
    existingCode: "x",
    title: `title ${fingerprint}`,
    body: "b",
    evidence: [],
    provenance: { task: "t1" },
    anchor: { method: "hunk", inDiff: true },
    status: "new",
    ...overrides,
  };
}

const task: TaskOutcome = {
  taskId: "t1",
  reviewer: "correctness",
  bundle: "b1",
  files: ["a.ts"],
  status: "completed",
  findings: 5,
  durationMs: 0,
  usage,
};

// A clock the test moves by hand.
function clock() {
  let now = 1_000;
  return {
    now: () => now,
    at: (ms: number) => {
      now = 1_000 + ms;
    },
  };
}

describe("TraceRecorder", () => {
  it("times stages, tasks, attempts and plain calls from the run's start", () => {
    const time = clock();
    const trace = new TraceRecorder(time.now);
    trace.record({ type: "stage_started", stage: "plan" });
    time.at(100);
    trace.record({ type: "stage_started", stage: "review" });
    trace.record({
      type: "task_started",
      taskId: "t1",
      reviewer: "correctness",
      bundle: "b1",
      files: ["a.ts"],
    });
    time.at(400);
    trace.record({
      type: "task_progress",
      taskId: "t1",
      message: "",
      attempt: {
        model: "p/m",
        read: ["a.ts"],
        searched: ["x(", "y("],
        text: "",
        steps: 3,
        tools: { read_file: 1 },
        ending: "step_cap",
        usage,
        ms: 250,
      },
    });
    trace.record({ type: "task_finished", outcome: task });
    time.at(500);
    trace.record({ type: "stage_started", stage: "judge" });
    time.at(700);
    trace.record({ type: "model_called", agent: "judge", model: "p/top", ms: 150, usage });
    time.at(800);
    const built = trace.build({ tasks: [task], findings: [] });

    expect(built.startedAt).toBe(new Date(1_000).toISOString());
    expect(built.ms).toBe(800);
    expect(built.stages).toEqual([
      { stage: "plan", startMs: 0, ms: 100 },
      { stage: "review", startMs: 100, ms: 400 },
      { stage: "judge", startMs: 500, ms: 300 },
    ]);
    expect(built.tasks[0]).toMatchObject({ startMs: 100, ms: 300 });
    expect(built.tasks[0]?.attempts).toEqual([
      {
        model: "p/m",
        startMs: 150,
        ms: 250,
        steps: 3,
        tools: { read_file: 1 },
        ending: "step_cap",
        read: ["a.ts"],
        searches: 2,
        usage,
      },
    ]);
    expect(built.calls).toEqual([
      { agent: "judge", stage: "judge", model: "p/top", startMs: 550, ms: 150, usage },
    ]);
  });

  it("says where each reported finding ended up, and why", () => {
    const trace = new TraceRecorder(() => 0);
    for (const fp of ["kept", "refuted", "early", "merged", "dropped", "filtered"]) {
      trace.record({ type: "finding", taskId: "t1", finding: finding(fp) });
    }
    trace.record({
      type: "finding_dropped",
      taskId: "t1",
      reason: "outside_review",
      file: "z.ts",
      title: "far away",
    });
    trace.record({
      type: "findings_verified",
      file: "a.ts",
      kept: [],
      refuted: ["id-early"],
      settled: [],
    });
    trace.record({
      type: "verification_finished",
      checked: 2,
      refuted: [
        { fingerprint: "refuted", file: "a.ts", title: "", reason: "the value is checked above" },
      ],
    });
    trace.record({
      type: "judge_finished",
      verdict: "minor_issues",
      judgement: {
        merged: [{ kept: "kept", merged: ["merged"] }],
        dropped: [{ fingerprint: "dropped", file: "a.ts", title: "", reason: "speculative" }],
        recalibrated: [
          { fingerprint: "kept", from: "warning", to: "critical", reason: "data loss" },
        ],
      },
    });
    const built = trace.build({
      tasks: [],
      findings: [finding("kept", { severity: "critical" }), finding("resumed")],
    });
    const fates = Object.fromEntries(built.findings.map((f) => [f.fingerprint ?? f.title, f]));

    expect(fates["far away"]).toMatchObject({ fate: "outside_review", file: "z.ts" });
    expect(fates.kept).toMatchObject({
      fate: "kept",
      severity: "critical",
      recalibrated: { from: "warning", to: "critical", reason: "data loss" },
    });
    expect(fates.refuted).toMatchObject({ fate: "refuted", reason: "the value is checked above" });
    expect(fates.early).toMatchObject({ fate: "refuted" });
    expect(fates.merged).toMatchObject({ fate: "merged", mergedInto: "kept" });
    expect(fates.dropped).toMatchObject({ fate: "dropped", reason: "speculative" });
    expect(fates.filtered).toMatchObject({ fate: "filtered" });
    expect(fates.resumed).toMatchObject({ fate: "kept" });
    expect(fates.resumed).not.toHaveProperty("taskId");
  });
});
