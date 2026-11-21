import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./cli.js";
import type { SavedSummary } from "./compare.js";
import { bootstrapBounds, recallVerdict, renderVerdict, upperTailP } from "./verdict.js";

// A golden run: each case id maps to which of its claims were found.
const run = (
  cases: Record<string, boolean[]>,
  {
    casesHash = "h1",
    cost = 1,
    ids = true,
  }: { casesHash?: string; cost?: number; ids?: boolean } = {},
): SavedSummary =>
  ({
    summary: {
      costPerReviewedUsd: cost,
      golden: {
        counts: { unadjudicated: 0 },
        casesHash,
        cases: Object.fromEntries(
          Object.entries(cases).map(([id, found]) => [
            id,
            {
              expected: found.length,
              found: found.filter(Boolean).length,
              reported: 1,
              right: 1,
              claims: found.map((f, k) => ({
                ...(ids ? { id: `claim-${k + 1}` } : {}),
                concern: `claim ${k + 1}`,
                found: f,
              })),
            },
          ]),
        ),
      },
    },
  }) as unknown as SavedSummary;

// n cases of two claims each, found as `pattern(i)` says.
const cases = (n: number, pattern: (i: number) => boolean[]) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`case-${i}`, pattern(i)]));

describe("upperTailP", () => {
  it("is the one-sided exact binomial tail", () => {
    expect(upperTailP(0, 0)).toBe(1);
    expect(upperTailP(3, 0)).toBeCloseTo(1 / 8, 12);
    expect(upperTailP(0, 3)).toBeCloseTo(1, 12);
    expect(upperTailP(5, 1)).toBeCloseTo(7 / 64, 12);
  });
});

describe("bootstrapBounds", () => {
  it("is zero wide when every case moved the same way", () => {
    const same = [
      { id: "a", expected: 2, baseline: 1, run: 2 },
      { id: "b", expected: 2, baseline: 1, run: 2 },
    ];
    expect(bootstrapBounds(same, { resamples: 1000, seed: 1 })).toEqual({ lower: 0.5, upper: 0.5 });
  });

  it("gives the same bounds for the same seed", () => {
    const mixed = [
      { id: "a", expected: 2, baseline: 0, run: 2 },
      { id: "b", expected: 2, baseline: 2, run: 1 },
      { id: "c", expected: 1, baseline: 1, run: 1 },
    ];
    const options = { resamples: 2000, seed: 7 };
    expect(bootstrapBounds(mixed, options)).toEqual(bootstrapBounds(mixed, options));
  });
});

describe("recallVerdict", () => {
  it("passes identical sides with a zero-width interval", () => {
    const side = [run(cases(10, (i) => [i % 2 === 0, true]))];
    const result = recallVerdict(side, side);
    expect(result).toMatchObject({
      verdict: "pass",
      difference: 0,
      lower: 0,
      upper: 0,
      claims: 20,
      signTest: { better: 0, worse: 0, tied: 10 },
    });
  });

  it("passes an A/A pair whose noise stays inside the margin", () => {
    const a = [run(cases(20, (i) => [i !== 0, i % 2 === 0]))];
    const b = [run(cases(20, (i) => [i !== 1, i % 2 === 0]))];
    const result = recallVerdict(a, b);
    expect(result).toMatchObject({ verdict: "pass", difference: 0 });
    if ("refused" in result) throw new Error("refused");
    expect(result.lower).toBeLessThan(0);
    expect(result.lower).toBeGreaterThan(-0.1);
  });

  it("calls an A/A pair of single runs that moved in many cases inconclusive", () => {
    const a = [run(cases(20, (i) => [i % 3 !== 0, i % 2 === 0]))];
    const b = [run(cases(20, (i) => [i % 3 !== 1, i % 2 === 0]))];
    expect(recallVerdict(a, b)).toMatchObject({ verdict: "inconclusive", difference: 0 });
  });

  it("calls a loss in most cases worse through the sign test", () => {
    const baseline = [run(cases(12, () => [true, true]))];
    const change = [run(cases(12, (i) => [i >= 9, true]))];
    expect(recallVerdict(baseline, change)).toMatchObject({
      verdict: "worse",
      signTest: { better: 0, worse: 9, tied: 3 },
      difference: -9 / 24,
    });
  });

  it("calls a small set with one large loss inconclusive", () => {
    const baseline = [run({ a: [true, true, true], b: [true], c: [false] })];
    const change = [run({ a: [false, false, true], b: [true], c: [true] })];
    expect(recallVerdict(baseline, change)).toMatchObject({ verdict: "inconclusive" });
  });

  it("averages each side's repeats per case", () => {
    const baseline = [run({ a: [true, false] }), run({ a: [false, false] })];
    const change = [run({ a: [true, true] }), run({ a: [true, false] })];
    const result = recallVerdict(baseline, change);
    if ("refused" in result) throw new Error("refused");
    expect(result.cases).toEqual([{ id: "a", expected: 2, baseline: 0.5, run: 1.5 }]);
    expect(result.baselineRecall).toBe(0.25);
    expect(result.runRecall).toBe(0.75);
  });

  it("names a cost trade-off a pass carries", () => {
    const side = (cost: number) => [
      run(
        cases(5, () => [true]),
        { cost },
      ),
    ];
    const result = recallVerdict(side(1), side(1.5));
    expect(result).toMatchObject({ verdict: "pass", costRatio: 1.5 });
    if ("refused" in result) throw new Error("refused");
    expect(result.reasons.join(" ")).toContain("names the trade-off");
  });

  it("uses only the cases every run reviewed, with required claims", () => {
    const baseline = [run({ a: [true], b: [false], clean: [] })];
    const change = [run({ a: [true], clean: [] })];
    const result = recallVerdict(baseline, change);
    if ("refused" in result) throw new Error("refused");
    expect(result.cases.map((c) => c.id)).toEqual(["a"]);
  });

  it("refuses runs scored against different cases or before claim ids", () => {
    const a = [run({ a: [true] })];
    expect(recallVerdict(a, [run({ a: [true] }, { casesHash: "h2" })])).toEqual({
      refused: "the runs were scored against different golden cases or labels; rescore them",
    });
    expect(recallVerdict(a, [run({ a: [true] }, { ids: false })])).toMatchObject({
      refused: expect.stringContaining("before claims had ids"),
    });
    expect(recallVerdict(a, [])).toMatchObject({ refused: expect.stringContaining("each side") });
  });

  it("renders the verdict and the cases that moved", () => {
    const text = renderVerdict(
      recallVerdict([run({ a: [true, true], b: [true] })], [run({ a: [true, false], b: [true] })]),
    );
    expect(text).toContain("Golden recall over 3 required claim(s) in 2 case(s)");
    expect(text).toContain("| a | 2.00 / 2 | 1.00 / 2 |");
    expect(text).not.toContain("| b |");
    expect(renderVerdict({ refused: "x" })).toContain("No verdict: x.");
  });
});

describe("ocra-eval verdict", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const saved = (scratch: string, label: string, summary: SavedSummary) => {
    const dir = join(scratch, label);
    mkdirSync(dir);
    writeFileSync(join(dir, "run.json"), JSON.stringify({ ids: ["a"] }));
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary));
    return dir;
  };
  const verdictOf = async (baseline: SavedSummary, change: SavedSummary, ...flags: string[]) => {
    const scratch = mkdtempSync(join(tmpdir(), "ocra-verdict-"));
    dirs.push(scratch);
    let text = "";
    const out = { write: (chunk: string) => (text += chunk) };
    const code = await main(
      ["verdict", saved(scratch, "base", baseline), saved(scratch, "change", change), ...flags],
      out,
      out,
    );
    return { code, text };
  };

  it("exits 0 on a pass, 1 on worse and 2 with no verdict", async () => {
    const all = run(cases(12, () => [true, true]));
    const fewer = run(cases(12, (i) => [i >= 9, true]));
    expect((await verdictOf(all, all)).code).toBe(0);
    const worse = await verdictOf(all, fewer);
    expect(worse.code).toBe(1);
    expect(worse.text).toContain("**worse**");
    expect(
      (
        await verdictOf(
          all,
          run(
            cases(12, () => [true, true]),
            { casesHash: "h2" },
          ),
        )
      ).code,
    ).toBe(2);
  });

  it("exits 3 when the bound misses a tighter margin", async () => {
    const baseline = run(cases(20, (i) => [i !== 0, true]));
    const change = run(cases(20, (i) => [i !== 1, true]));
    expect((await verdictOf(baseline, change)).code).toBe(0);
    expect((await verdictOf(baseline, change, "--margin", "0.02")).code).toBe(3);
    expect((await verdictOf(baseline, change, "--margin", "5")).code).toBe(2);
  });
});
