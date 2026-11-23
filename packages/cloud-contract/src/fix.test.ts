import { describe, expect, it } from "vitest";
import { FIX_REASONS, fixResultSchema } from "./fix.js";
import { sharedFindingSchema } from "./upload.js";

const usage = { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0, costUsd: 0 };
const proposed = {
  fingerprint: "b491fb26b470419c",
  headSha: "a".repeat(40),
  outcome: "proposed",
  fix: { startLine: 3, endLine: 3, replacement: "  return n;" },
  reason: null,
  usage,
} as const;

describe("ocra fix's result", () => {
  it("holds a fix only when one was proposed", () => {
    expect(fixResultSchema.parse(proposed)).toEqual(proposed);
    expect(fixResultSchema.safeParse({ ...proposed, fix: null }).success).toBe(false);
    expect(
      fixResultSchema.safeParse({ ...proposed, outcome: "rejected", reason: "syntax" }).success,
    ).toBe(false);
  });

  it("gives a reason for every outcome but proposed and head_moved", () => {
    const without = { ...proposed, fix: null };
    expect(
      fixResultSchema.safeParse({ ...without, outcome: "stale", reason: "stale" }).success,
    ).toBe(true);
    expect(fixResultSchema.safeParse({ ...without, outcome: "stale" }).success).toBe(false);
    expect(fixResultSchema.safeParse({ ...without, outcome: "head_moved" }).success).toBe(true);
    expect(
      fixResultSchema.safeParse({ ...without, outcome: "head_moved", reason: "stale" }).success,
    ).toBe(false);
    expect(FIX_REASONS).toContain("not_candidate");
  });

  it("refuses an unknown outcome or reason, and a head that is not a commit id", () => {
    const without = { ...proposed, fix: null };
    expect(fixResultSchema.safeParse({ ...without, outcome: "done", reason: "x" }).success).toBe(
      false,
    );
    expect(
      fixResultSchema.safeParse({ ...without, outcome: "rejected", reason: "maybe" }).success,
    ).toBe(false);
    expect(fixResultSchema.safeParse({ ...proposed, headSha: "HEAD" }).success).toBe(false);
  });
});

describe("a shared finding's low confidence", () => {
  const finding = {
    fingerprint: "b491fb26b470419c",
    reviewer: "correctness",
    severity: "warning",
    file: "src/a.ts",
    lineStart: 3,
    lineEnd: 3,
    title: "t",
    body: "b",
  };

  it("is kept when set, and anything else reads as absent", () => {
    expect(sharedFindingSchema.parse({ ...finding, lowConfidence: true }).lowConfidence).toBe(true);
    expect(sharedFindingSchema.parse({ ...finding, lowConfidence: "yes" }).lowConfidence).toBe(
      undefined,
    );
  });
});
