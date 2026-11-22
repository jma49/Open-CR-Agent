import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./cli.js";
import type { SavedSummary } from "./compare.js";
import { halves, noiseBaseline, renderNoise } from "./noise.js";

const run = (cases: Record<string, boolean[]>, casesHash = "h1"): SavedSummary =>
  ({
    info: {
      judge: "judge-1",
      selection: { dataset: "golden" },
      ocra: { version: "0.10.0", commit: "abc", maxAgentSteps: 30 },
    },
    summary: {
      costPerReviewedUsd: 1,
      golden: {
        counts: { unadjudicated: 0 },
        casesHash,
        cases: Object.fromEntries(
          Object.entries(cases).map(([id, found]) => [
            id,
            {
              expected: found.length,
              found: found.filter(Boolean).length,
              claims: found.map((f, k) => ({ id: `claim-${k + 1}`, concern: "c", found: f })),
            },
          ]),
        ),
      },
    },
  }) as unknown as SavedSummary;

const cases = (n: number, pattern: (i: number) => boolean[]) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`case-${i}`, pattern(i)]));

const options = { margin: 0.1, maxCostRatio: 1.25, resamples: 2000, seed: 1 };

describe("halves", () => {
  it("lists each split of the runs once, not its mirror", () => {
    expect(halves(4)).toEqual([
      [
        [0, 1],
        [2, 3],
      ],
      [
        [0, 2],
        [1, 3],
      ],
      [
        [0, 3],
        [1, 2],
      ],
    ]);
    expect(halves(6)).toHaveLength(10);
  });
});

describe("noiseBaseline", () => {
  it("refuses an odd number of runs or too few", () => {
    const one = run({ a: [true] });
    expect(noiseBaseline([one, one, one], options)).toHaveProperty("refused");
    expect(noiseBaseline([one, one], options)).toHaveProperty("refused");
    expect(noiseBaseline(Array(5).fill(one), options)).toHaveProperty("refused");
  });

  it("passes identical runs with no spread and a 1-point margin", () => {
    const same = run(cases(10, (i) => [i % 2 === 0, true]));
    const result = noiseBaseline([same, same, same, same], options);
    if ("refused" in result) throw new Error(result.refused);
    expect(result).toMatchObject({
      runs: 4,
      cases: 10,
      claims: 20,
      splits: 3,
      falseAlarms: 0,
      requiredMargin: 1,
      passed: true,
    });
    expect(result.recall.sd).toBe(0);
    expect(result.recall.mean).toBeCloseTo(0.75, 12);
  });

  it("finds the margin noisy runs need, larger than the spread of identical ones", () => {
    const flip = (k: number) =>
      run(cases(12, (i) => [(i + k) % 3 !== 0, (i * k) % 4 !== 1, i % 2 === 0]));
    const result = noiseBaseline([flip(1), flip(2), flip(3), flip(4), flip(5), flip(6)], options);
    if ("refused" in result) throw new Error(result.refused);
    expect(result.splits).toBe(10);
    expect(result.recall.sd).toBeGreaterThan(0);
    expect(result.requiredMargin).toBeGreaterThan(1);
    expect(result.requiredMargin).toBe(Math.floor(result.lowerBound.worst * 100) + 1);
    expect(result.lowerBound.median).toBeLessThanOrEqual(result.lowerBound.worst);
  });

  it("counts a split called worse as a false alarm", () => {
    const good = run(cases(10, () => [true, true]));
    const bad = run(cases(10, () => [false, false]));
    const result = noiseBaseline([good, good, bad, bad], options);
    if ("refused" in result) throw new Error(result.refused);
    expect(result.falseAlarms).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
    expect(renderNoise("b", result)).toContain("**A/A check failed**");
  });

  it("refuses runs scored against different cases", () => {
    const a = run({ x: [true] }, "h1");
    const b = run({ x: [true] }, "h2");
    expect(noiseBaseline([a, a, b, b], options)).toEqual({
      refused: "the runs were scored against different golden cases or labels; rescore them",
    });
  });
});

describe("ocra-eval noise", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const repeated = (summaries: SavedSummary[]) => {
    const dir = mkdtempSync(join(tmpdir(), "ocra-noise-"));
    dirs.push(dir);
    const runDir = join(dir, "smoke-baseline");
    const names = summaries.map((_, n) => `r${n + 1}`);
    for (const [n, saved] of summaries.entries()) {
      mkdirSync(join(runDir, names[n] as string), { recursive: true });
      writeFileSync(join(runDir, names[n] as string, "summary.json"), JSON.stringify(saved));
      writeFileSync(join(runDir, names[n] as string, "run.json"), JSON.stringify({ ids: ["x"] }));
    }
    writeFileSync(
      join(runDir, "repeats.json"),
      JSON.stringify({ repeat: names.length, runs: names }),
    );
    return { dir, runDir };
  };

  const capture = () => {
    let text = "";
    return { write: (chunk: string) => (text += chunk), text: () => text };
  };

  it("registers a passing baseline once per label", async () => {
    const same = run(cases(6, () => [true, false]));
    const { dir, runDir } = repeated([same, same, same, same]);
    const registry = join(dir, "baselines.json");
    for (let i = 0; i < 2; i++) {
      const out = capture();
      const err = capture();
      expect(await main(["noise", runDir, "--register", registry], out, err), err.text()).toBe(0);
      expect(out.text()).toContain("**A/A check passed**");
    }
    const entries = JSON.parse(readFileSync(registry, "utf8"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      label: "smoke-baseline",
      casesHash: "h1",
      ocraCommit: "abc",
      judge: "judge-1",
      runs: 4,
      claims: 12,
      recallMean: 0.5,
      requiredMargin: 1,
      aaPassed: true,
    });
  });

  it("exits 2 without enough repeats", async () => {
    const same = run(cases(2, () => [true]));
    const { runDir } = repeated([same, same]);
    const out = capture();
    expect(await main(["noise", runDir], out, capture())).toBe(2);
    expect(out.text()).toContain("No baseline");
  });
});
