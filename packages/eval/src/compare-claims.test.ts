import { describe, expect, it } from "vitest";
import type { SavedSummary } from "./compare.js";
import { compareClaims, signTestP } from "./compare-claims.js";

// A golden run of one case whose expected findings were found as `found`.
const run = (found: boolean[], casesHash = "h1", recall = 0): SavedSummary =>
  ({
    summary: {
      overall: { metrics: { precision: 0.5, recall: 0.5, f1: 0.5 } },
      costPerReviewedUsd: 1,
      durationSeconds: { median: 60 },
      golden: {
        precision: 0.5,
        recall,
        failures: [],
        counts: { unadjudicated: 0 },
        casesHash,
        cases: {
          c: {
            expected: found.length,
            found: found.filter(Boolean).length,
            reported: 1,
            right: 1,
            claims: found.map((f, k) => ({ concern: `claim ${k + 1} | x`, found: f })),
          },
        },
      },
    },
  }) as unknown as SavedSummary;

const many = (n: number, value: boolean) => Array.from({ length: n }, () => value);

describe("signTestP", () => {
  it("is the two-sided exact binomial probability", () => {
    expect(signTestP(0, 0)).toBe(1);
    expect(signTestP(3, 0)).toBeCloseTo(0.25, 12);
    expect(signTestP(1, 1)).toBe(1);
    expect(signTestP(8, 0)).toBeCloseTo(2 / 256, 12);
    expect(signTestP(2000, 0)).toBe(0);
  });
});

describe("compareClaims", () => {
  it("reports a known difference over claims and repeats", () => {
    const baseline = [run(many(10, false)), run(many(10, false)), run(many(10, false))];
    const change = [run(many(10, true)), run(many(10, true)), run(many(10, false))];
    const result = compareClaims(baseline, change);
    expect(result?.test).toMatchObject({ better: 10, worse: 0, tied: 0, verdict: "better" });
    expect(result?.differing[0]).toEqual({
      id: "c#1",
      concern: "claim 1 | x",
      baseline: { hits: 0, runs: 3 },
      run: { hits: 2, runs: 3 },
    });
  });

  it("finds nothing between identical sides", () => {
    const side = [run([true, false]), run([false, false])];
    expect(compareClaims(side, side)?.test).toMatchObject({
      better: 0,
      worse: 0,
      tied: 2,
      pValue: 1,
      verdict: "no change",
    });
  });

  it("refuses to pair runs scored against different cases", () => {
    expect(compareClaims([run([true])], [run([true], "h2")])?.refused).toMatch(/different golden/);
  });

  it("refuses to pair runs whose golden cases were not hashed", () => {
    const unhashed = (found: boolean[]): SavedSummary => {
      const saved = run(found);
      if (saved.summary.golden) delete (saved.summary.golden as { casesHash?: string }).casesHash;
      return saved;
    };
    expect(compareClaims([unhashed([true])], [unhashed([false])])?.refused).toMatch(/hashed/);
  });

  it("does nothing without per-case scores", () => {
    const old = { summary: { golden: { casesHash: "h1" } } } as unknown as SavedSummary;
    expect(compareClaims([old], [old])).toBeUndefined();
  });
});
