import { MAX_TRACE_BYTES, MAX_TRACE_TASKS, sharedTraceSchema } from "@open-cr-agent/cloud-contract";
import type { ReviewTrace, TraceTask } from "@open-cr-agent/core";
import { reviewReport } from "@open-cr-agent/test-support";
import { describe, expect, it } from "vitest";
import { cloudUpload } from "./review.js";
import { sharedTrace } from "./trace.js";

const usage = {
  inputTokens: 10,
  outputTokens: 2,
  reasoningTokens: 0,
  cachedTokens: 4,
  costUsd: 0.01,
};

function task(id: string, read: string[] = ["src/a.ts"]): TraceTask {
  return {
    id,
    reviewer: "correctness",
    bundle: "src",
    files: ["src/a.ts"],
    status: "completed",
    startMs: 10.4,
    ms: 300,
    usage,
    attempts: [
      {
        model: "anthropic/claude-sonnet-5-5",
        startMs: 11,
        ms: 280,
        steps: 4,
        tools: { read_file: 2, task_done: 1 },
        ending: "done",
        read,
        searches: 1,
        usage,
      },
    ],
  };
}

const trace: ReviewTrace = {
  startedAt: "2026-11-24T08:00:00.000Z",
  ms: 1_200,
  stages: [{ stage: "review", startMs: 0, ms: 900 }],
  tasks: [task("t1")],
  calls: [
    {
      agent: "judge",
      stage: "judge",
      model: "anthropic/claude-opus-5-5",
      startMs: 950,
      ms: 200,
      usage,
    },
  ],
  findings: [
    {
      fingerprint: "aaaabbbbccccdddd",
      reviewer: "correctness",
      severity: "warning",
      file: "src/a.ts",
      title: "Token logged",
      fate: "dropped",
      reason: "It only logs api_key=sk-live-0123456789abcdef in tests.",
    },
  ],
};

describe("sharedTrace", () => {
  it("sends the trace as the contract reads it, reasons redacted", () => {
    const shared = sharedTrace(trace);
    expect(sharedTraceSchema.safeParse(shared).success).toBe(true);
    expect(shared?.tasks[0]).toMatchObject({ startMs: 10, attempts: [{ read: ["src/a.ts"] }] });
    expect(shared?.findings[0]?.reason).toBe("It only logs api_key=[redacted] in tests.");
    expect(shared?.redacted).toBe(true);
  });

  it("sends an attempt that ended at its model's context window", () => {
    const [attempt] = task("t1").attempts;
    const cut = {
      ...task("t1"),
      attempts: attempt ? [{ ...attempt, ending: "context_window" as const }] : [],
    };
    expect(sharedTrace({ ...trace, tasks: [cut] })?.tasks[0]?.attempts[0]?.ending).toBe(
      "context_window",
    );
  });

  it("keeps the contract's bounds, and leaves out what attempts read when the trace is too large", () => {
    const many = Array.from({ length: MAX_TRACE_TASKS + 5 }, (_, i) =>
      task(
        `t${i}`,
        Array.from({ length: 200 }, (_, j) => `src/${"d/".repeat(20)}${j}.ts`),
      ),
    );
    const shared = sharedTrace({ ...trace, tasks: many });
    expect(shared?.tasks).toHaveLength(MAX_TRACE_TASKS);
    expect(shared?.truncated).toBe(true);
    expect(shared?.tasks.every((t) => t.attempts.every((a) => a.read.length === 0))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(shared))).toBeLessThanOrEqual(MAX_TRACE_BYTES);
  });

  it("goes only with the findings", () => {
    const report = reviewReport({ trace });
    const cloud = (shareFindings: boolean) => ({
      repository: "https://github.com/octo/app",
      repoHash: "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
      shareFindings,
    });
    const run = { source: "local" as const, durationMs: 1 };
    expect(cloudUpload(report, cloud(false), run).upload).not.toHaveProperty("trace");
    expect(cloudUpload(report, cloud(true), run).upload.trace?.tasks).toHaveLength(1);
  });
});
