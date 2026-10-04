import { describe, expect, it } from "vitest";
import { baselineOf, compareCeiling, renderComparison } from "./ceiling-gate.mjs";

function ceiling(reaches) {
  const instances = new Set(reaches.map((r) => r.instance));
  return {
    summary: {
      instances: instances.size,
      references: reaches.length,
      byReach: { reachable: reaches.filter((r) => r.reach === "reachable").length },
    },
    reaches,
  };
}

const BASE = baselineOf(
  ceiling([
    { instance: "a", path: "x.ts", reach: "reachable" },
    { instance: "a", path: "x.ts", reach: "outside_diff" },
    { instance: "b", path: "y.go", reach: "reachable" },
  ]),
);

describe("ceiling gate", () => {
  it("numbers repeated references on one path", () => {
    expect(BASE.reaches).toEqual({
      "a x.ts #1": "reachable",
      "a x.ts #2": "outside_diff",
      "b y.go #1": "reachable",
    });
    expect(BASE.reachable).toBe(2);
  });

  it("passes an unchanged measurement", () => {
    const result = compareCeiling(BASE, BASE);
    expect(result).toEqual({ changes: [], problems: [], improved: false });
  });

  it("fails when a reachable reference stops being reachable, and shows it", () => {
    const now = baselineOf(
      ceiling([
        { instance: "a", path: "x.ts", reach: "file_excluded" },
        { instance: "a", path: "x.ts", reach: "outside_diff" },
        { instance: "b", path: "y.go", reach: "reachable" },
      ]),
    );
    const result = compareCeiling(BASE, now);
    expect(result.problems).toEqual([
      "1 reachable, the baseline has 2",
      "no longer reachable: a x.ts #1 (file_excluded)",
    ]);
    expect(renderComparison(BASE, now, result)).toContain(
      "| a x.ts #1 | reachable | file_excluded |",
    );
  });

  it("fails when a case could not be classified", () => {
    const now = baselineOf(ceiling([{ instance: "a", path: "x.ts", reach: "reachable" }]));
    const result = compareCeiling(BASE, now);
    expect(result.problems[0]).toMatch(/1 case\(s\) classified, the baseline has 2/);
    expect(result.problems).toContain("no longer reachable: b y.go #1 (absent)");
  });

  it("fails a loss hidden behind a gain", () => {
    const now = baselineOf(
      ceiling([
        { instance: "a", path: "x.ts", reach: "outside_diff" },
        { instance: "a", path: "x.ts", reach: "reachable" },
        { instance: "b", path: "y.go", reach: "reachable" },
      ]),
    );
    const result = compareCeiling(BASE, now);
    expect(now.reachable).toBe(BASE.reachable);
    expect(result.problems).toEqual(["no longer reachable: a x.ts #1 (outside_diff)"]);
  });

  it("asks to record an improvement", () => {
    const now = baselineOf(
      ceiling([
        { instance: "a", path: "x.ts", reach: "reachable" },
        { instance: "a", path: "x.ts", reach: "reachable" },
        { instance: "b", path: "y.go", reach: "reachable" },
      ]),
    );
    const result = compareCeiling(BASE, now);
    expect(result.problems).toEqual([]);
    expect(result.improved).toBe(true);
    expect(renderComparison(BASE, now, result)).toContain("--write");
  });
});
