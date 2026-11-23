import { describe, expect, it } from "vitest";
import { overBudget, renderPerf } from "./budget.js";
import type { PerfResult } from "./measure.js";

const calls = { requests: 10, inputTokens: 4000, repeatedTokens: 3000, largestRequestTokens: 900 };
const none = { requests: 0, inputTokens: 0, repeatedTokens: 0, largestRequestTokens: 0 };
const result: PerfResult = {
  runtime: "direct",
  latencyMs: 0,
  review: { exitCode: 0, files: 4, tasks: 5, findings: 2 },
  wallMs: 1500,
  cpuMs: 900,
  peakMemoryMb: 150,
  git: { processes: 12, byCommand: { grep: 3, "rev-parse": 9 } },
  model: { ...calls, byKind: { review: calls, judge: none } },
};

describe("overBudget", () => {
  it("is empty at or under every ceiling, and for a measure without one", () => {
    expect(overBudget(result, {})).toEqual([]);
    expect(overBudget(result, { gitProcesses: 12, inputTokens: 4000, cpuMs: 901 })).toEqual([]);
  });

  it("names each measure over its ceiling with both numbers", () => {
    expect(overBudget(result, { gitProcesses: 11, modelRequests: 10, peakMemoryMb: 100 })).toEqual([
      "peak memory (MB): 150, over its budget of 100",
      "git processes: 12, over its budget of 11",
    ]);
  });
});

describe("renderPerf", () => {
  it("shows the measures, git's commands by count and only the model calls made", () => {
    const text = renderPerf(result);
    expect(text).toContain("| git processes | 12 (rev-parse 9, grep 3) |");
    expect(text).toContain("| Input tokens | 4000 (75% repeat the start of an earlier request) |");
    expect(text).toContain("| review | 10 | 4000 | 900 | 75% |");
    expect(text).not.toContain("| judge |");
  });
});
