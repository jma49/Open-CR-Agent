import { describe, expect, it } from "vitest";
import { smokeErrors, smokeLine } from "./live-smoke.mjs";

const done = { taskId: "t1", status: "completed" };
const good = {
  version: 1,
  runId: "r1",
  verdict: "approved",
  tasks: [done],
  findings: [{ fingerprint: "f1", provenance: { model: "router/m" } }],
  usage: { costUsd: 0, inputTokens: 10, outputTokens: 2 },
};

/** @param {string} taskId */
const quota = (taskId) => ({
  taskId,
  status: "failed",
  error: "HTTP 429: Rate limit exceeded: free-models-per-day",
});

describe("smokeErrors", () => {
  it("passes a complete review on the free model at no cost", () => {
    expect(smokeErrors(good, "m", "0")).toEqual([]);
    expect(smokeErrors(good, "m", "1")).toEqual([]);
  });

  it("lists every way a review falls short", () => {
    const bad = {
      version: 2,
      tasks: [done, { taskId: "t2", status: "failed", error: "boom" }],
      findings: [{ fingerprint: "f1", provenance: { model: "router/other" } }],
      usage: { costUsd: 0.5, inputTokens: 0, outputTokens: 0 },
    };
    expect(smokeErrors(bad, "m", "3")).toEqual([
      "::error title=Live smoke failed::ocra review exited 3",
      "::error title=Live smoke failed::report version 2",
      "::error title=Live smoke failed::task t2 failed: boom",
      "::error title=Live smoke failed::cost $0.5, expected $0 on the free model",
      "::error title=Live smoke failed::no tokens reported",
      "::error title=Live smoke failed::finding f1 from router/other",
    ]);
  });

  it("fails a night whose free quota is spent, by name, rather than skipping it", () => {
    const spent = { ...good, tasks: [quota("t1"), quota("t2")], findings: [] };
    expect(smokeErrors(spent, "m", "2")).toEqual([
      "::error title=Live smoke reviewed nothing::the free model quota is spent: all 2 task(s) failed on it; it resets at 00:00 UTC",
      "::error title=Live smoke failed::ocra review exited 2",
      "::error title=Live smoke failed::task t1 failed: HTTP 429: Rate limit exceeded: free-models-per-day",
      "::error title=Live smoke failed::task t2 failed: HTTP 429: Rate limit exceeded: free-models-per-day",
    ]);
  });

  it("says it reviewed nothing when no task ran, none completed, or there is no report", () => {
    /** @param {import("./live-smoke.mjs").SmokeReport} report */
    const nothing = (report, exitCode = "0") => smokeErrors(report, "m", exitCode)[0];
    expect(nothing({ ...good, tasks: [] })).toBe(
      "::error title=Live smoke reviewed nothing::no review task ran",
    );
    expect(
      nothing({ ...good, tasks: [quota("t1"), { taskId: "t2", status: "failed" }] }, "3"),
    ).toBe("::error title=Live smoke reviewed nothing::none of the 2 task(s) completed");
    expect(smokeErrors(undefined, "m", "2")).toEqual([
      "::error title=Live smoke reviewed nothing::ocra wrote no report",
      "::error title=Live smoke failed::ocra review exited 2",
    ]);
  });

  it("keeps a multi-line error in one annotation", () => {
    const task = { taskId: "t2", status: "failed", error: "50% done\r\n::warning::injected" };
    expect(smokeErrors({ ...good, tasks: [done, task] }, "m", "0")).toEqual([
      "::error title=Live smoke failed::task t2 failed: 50%25 done%0D%0A::warning::injected",
    ]);
  });
});

describe("smokeLine", () => {
  it("sums the run up", () => {
    expect(smokeLine(good)).toBe(
      "1 task(s), 1 finding(s), verdict approved, 10 in / 2 out tokens, run r1",
    );
  });
});
