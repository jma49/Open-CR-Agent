import { describe, expect, it } from "vitest";
import { smokeLine, smokeProblems } from "./live-smoke.mjs";

const good = {
  version: 1,
  runId: "r1",
  verdict: "approved",
  tasks: [{ taskId: "t1", status: "completed" }],
  findings: [{ fingerprint: "f1", provenance: { model: "router/m" } }],
  usage: { costUsd: 0, inputTokens: 10, outputTokens: 2 },
};

describe("smokeProblems", () => {
  it("passes a complete review on the free model at no cost", () => {
    expect(smokeProblems(good, "m")).toEqual([]);
  });

  it("lists every way a review falls short", () => {
    const bad = {
      version: 2,
      tasks: [{ taskId: "t1", status: "failed", error: "boom" }],
      findings: [{ fingerprint: "f1", provenance: { model: "router/other" } }],
      usage: { costUsd: 0.5, inputTokens: 0, outputTokens: 0 },
    };
    expect(smokeProblems(bad, "m")).toEqual([
      "report version 2",
      "task t1 failed: boom",
      "cost $0.5, expected $0 on the free model",
      "no tokens reported",
      "finding f1 from router/other",
    ]);
    expect(smokeProblems({ ...good, tasks: [] }, "m")).toEqual(["no review task ran"]);
  });
});

describe("smokeLine", () => {
  it("sums the run up", () => {
    expect(smokeLine(good)).toBe(
      "1 task(s), 1 finding(s), verdict approved, 10 in / 2 out tokens, run r1",
    );
  });
});
