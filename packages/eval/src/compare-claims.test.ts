import { describe, expect, it } from "vitest";
import type { SavedSummary } from "./compare.js";
import { compareClaims, signTestP } from "./compare-claims.js";

// A golden run of one case whose claims were found as `found`; the ids
// follow `order`, so a run can list the same claims in another order.
const run = (
  found: boolean[],
  casesHash = "h1",
  recall = 0,
  order = found.map((_, k) => k),
): SavedSummary =>
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
            claims: order.map((k) => ({
              id: `claim-${k + 1}`,
              concern: `claim ${k + 1} | x`,
              found: found[k] ?? false,
            })),
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
      id: "c#claim-1",
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

  it("pairs claims by id, whatever their order, and leaves optional ones out", () => {
    const baseline = [run([true, false]), run([true, false])];
    const reordered = [run([true, false], "h1", 0, [1, 0]), run([true, false], "h1", 0, [1, 0])];
    expect(compareClaims(baseline, reordered)?.test).toMatchObject({ better: 0, worse: 0 });
    const withOptional = reordered.map((saved) => {
      const claims = saved.summary.golden?.cases?.c?.claims ?? [];
      claims.push({ id: "extra", concern: "found by a model once", found: true, optional: true });
      return saved;
    });
    expect(compareClaims(baseline, withOptional)?.claims).toBe(2);
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

  it("refuses to pair runs scored before claims had ids, rather than finding no change", () => {
    const old = (found: boolean[]): SavedSummary => {
      const saved = run(found);
      for (const claim of saved.summary.golden?.cases?.c?.claims ?? []) {
        delete (claim as { id?: string }).id;
      }
      return saved;
    };
    const result = compareClaims([old([true, true])], [old([false, false])]);
    expect(result).toMatchObject({
      claims: 0,
      refused: "some runs were scored before claims had ids",
    });
    expect(result?.test).toBeUndefined();
  });

  it("does nothing without per-case scores", () => {
    const old = { summary: { golden: { casesHash: "h1" } } } as unknown as SavedSummary;
    expect(compareClaims([old], [old])).toBeUndefined();
  });
});
