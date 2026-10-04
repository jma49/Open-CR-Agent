import { describe, expect, it } from "vitest";
import type { Instance } from "./instance.js";
import type { InstanceResult } from "./results.js";
import { score } from "./score.js";

const instance = (id: string): Instance => ({
  id,
  repo: "o/r",
  prUrl: "u",
  language: "Go",
  prCategory: "c",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  changeLines: 1,
  references: [],
});

const result = (id: string, anchoring?: InstanceResult["anchoring"]): InstanceResult => ({
  id,
  status: "reviewed",
  durationMs: 1,
  findings: [],
  usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 },
  tasks: [],
  ...(anchoring ? { anchoring } : {}),
});

const judge = { sameIssue: async () => false };

describe("score anchoring", () => {
  it("sums how findings were anchored and reports the file-level share", async () => {
    const summary = await score(
      [instance("a"), instance("b"), instance("old")],
      [
        result("a", {
          byMethod: { hunk: 2, file: 0, cross_file: 0, relocated: 1, file_level: 1 },
          ambiguous: 1,
          relocationCalls: 2,
        }),
        result("b", {
          byMethod: { hunk: 3, file: 1, cross_file: 0, relocated: 0, file_level: 0 },
          ambiguous: 0,
          relocationCalls: 0,
        }),
        // Written before anchoring was published: counted in nothing.
        result("old"),
      ],
      judge,
    );
    expect(summary.anchoring).toEqual({
      byMethod: { hunk: 5, file: 1, cross_file: 0, relocated: 1, file_level: 1 },
      ambiguous: 1,
      relocationCalls: 2,
      fileLevelShare: 1 / 8,
    });
  });

  it("leaves anchoring out when no result reported it", async () => {
    const summary = await score([instance("old")], [result("old")], judge);
    expect(summary.anchoring).toBeUndefined();
  });
});
