import { describe, expect, it } from "vitest";
import { baselineOf, compareCeiling, renderComparison } from "./ceiling-gate.mjs";

/** @param {{ instance: string, claim?: string, optional?: boolean, reach: string }[]} reaches */
function ceiling(reaches) {
  const instances = new Set(reaches.map((r) => r.instance));
  const counted = reaches.filter((r) => !r.optional);
  return {
    summary: {
      instances: instances.size,
      references: counted.length,
      byReach: { reachable: counted.filter((r) => r.reach === "reachable").length },
    },
    reaches,
  };
}

const BASE = baselineOf(
  ceiling([
    { instance: "a", claim: "stray-entry", reach: "reachable" },
    { instance: "a", claim: "exit-order", reach: "outside_diff" },
    { instance: "b", claim: "missing-break", reach: "reachable" },
  ]),
);

describe("ceiling gate", () => {
  it("keys each claim by its case and id", () => {
    expect(BASE.reaches).toEqual({
      "a exit-order": "outside_diff",
      "a stray-entry": "reachable",
      "b missing-break": "reachable",
    });
    expect(BASE.reachable).toBe(2);
  });

  it("keeps the keys when a case's claims are reordered", () => {
    const reordered = baselineOf(
      ceiling([
        { instance: "a", claim: "exit-order", reach: "outside_diff" },
        { instance: "b", claim: "missing-break", reach: "reachable" },
        { instance: "a", claim: "stray-entry", reach: "reachable" },
      ]),
    );
    expect(compareCeiling(BASE, reordered)).toEqual({
      changes: [],
      problems: [],
      improved: false,
    });
  });

  it("leaves optional claims out of the baseline", () => {
    const withOptional = baselineOf(
      ceiling([
        { instance: "a", claim: "stray-entry", reach: "reachable" },
        { instance: "a", claim: "exit-order", reach: "outside_diff" },
        { instance: "a", claim: "old-bypass", optional: true, reach: "outside_diff" },
        { instance: "b", claim: "missing-break", reach: "reachable" },
      ]),
    );
    expect(withOptional).toEqual(BASE);
  });

  it("refuses a measurement whose reaches have no claim id", () => {
    expect(() => baselineOf(ceiling([{ instance: "a", reach: "reachable" }]))).toThrow(
      "a: a reach without a claim id",
    );
  });

  it("passes an unchanged measurement", () => {
    const result = compareCeiling(BASE, BASE);
    expect(result).toEqual({ changes: [], problems: [], improved: false });
  });

  it("fails when a reachable claim stops being reachable, and shows it", () => {
    const now = baselineOf(
      ceiling([
        { instance: "a", claim: "stray-entry", reach: "file_excluded" },
        { instance: "a", claim: "exit-order", reach: "outside_diff" },
        { instance: "b", claim: "missing-break", reach: "reachable" },
      ]),
    );
    const result = compareCeiling(BASE, now);
    expect(result.problems).toEqual([
      "1 reachable, the baseline has 2",
      "no longer reachable: a stray-entry (file_excluded)",
    ]);
    expect(renderComparison(BASE, now, result)).toContain(
      "| a stray-entry | reachable | file_excluded |",
    );
  });

  it("fails when a case could not be classified", () => {
    const now = baselineOf(ceiling([{ instance: "a", claim: "stray-entry", reach: "reachable" }]));
    const result = compareCeiling(BASE, now);
    expect(result.problems[0]).toMatch(/1 case\(s\) classified, the baseline has 2/);
    expect(result.problems).toContain("no longer reachable: b missing-break (absent)");
  });

  it("fails a loss hidden behind a gain", () => {
    const now = baselineOf(
      ceiling([
        { instance: "a", claim: "stray-entry", reach: "outside_diff" },
        { instance: "a", claim: "exit-order", reach: "reachable" },
        { instance: "b", claim: "missing-break", reach: "reachable" },
      ]),
    );
    const result = compareCeiling(BASE, now);
    expect(now.reachable).toBe(BASE.reachable);
    expect(result.problems).toEqual(["no longer reachable: a stray-entry (outside_diff)"]);
  });

  it("asks to record an improvement", () => {
    const now = baselineOf(
      ceiling([
        { instance: "a", claim: "stray-entry", reach: "reachable" },
        { instance: "a", claim: "exit-order", reach: "reachable" },
        { instance: "b", claim: "missing-break", reach: "reachable" },
      ]),
    );
    const result = compareCeiling(BASE, now);
    expect(result.problems).toEqual([]);
    expect(result.improved).toBe(true);
    expect(renderComparison(BASE, now, result)).toContain("--write");
  });
});
