import type { SavedSummary } from "./compare.js";
import { DEFAULT_VERDICT, recallVerdict, type VerdictOptions } from "./verdict.js";

// The noise baseline (eval plan §4.4): k repeats of one setup, split into two
// halves every way, each split judged by the merge verdict as if it were a
// change. Nothing changed between the halves, so a split called worse is a
// false alarm, and the margin every split passes at is the smallest the
// verdict can use with k/2 runs a side.

const MIN_NOISE_RUNS = 4;
// C(9, 4) = 126 splits, each a full bootstrap: enough to see the spread.
const MAX_NOISE_RUNS = 10;

export interface NoiseBaseline {
  runs: number;
  cases: number;
  claims: number;
  recall: { values: number[]; mean: number; sd: number };
  splits: number;
  falseAlarms: number;
  // How far below zero each split's lower bound lies, across splits.
  lowerBound: { median: number; worst: number };
  // The smallest margin, in whole points, at which every split passes.
  requiredMargin: number;
  passesAt: { margin: number; splits: number };
  passed: boolean;
}

export type NoiseResult = NoiseBaseline | { refused: string };

export function noiseBaseline(
  runs: readonly SavedSummary[],
  options: VerdictOptions = DEFAULT_VERDICT,
): NoiseResult {
  if (runs.length < MIN_NOISE_RUNS || runs.length % 2 !== 0 || runs.length > MAX_NOISE_RUNS) {
    return {
      refused: `a noise baseline needs an even number of repeats from ${MIN_NOISE_RUNS} to ${MAX_NOISE_RUNS}, not ${runs.length}`,
    };
  }
  const values = runs.map(recallOf);
  if (values.some((v) => v === undefined)) {
    return { refused: "some runs have no golden recall; rescore them" };
  }
  const verdicts = halves(runs.length).map(([a, b]) =>
    recallVerdict(
      a.map((i) => runs[i] as SavedSummary),
      b.map((i) => runs[i] as SavedSummary),
      options,
    ),
  );
  const refused = verdicts.find((v) => "refused" in v);
  if (refused && "refused" in refused) return { refused: refused.refused };
  const judged = verdicts.flatMap((v) => ("refused" in v ? [] : [v]));
  const first = judged[0];
  if (!first) return { refused: "no split could be judged" };
  const depths = judged.map((v) => Math.max(0, -v.lower)).sort((x, y) => x - y);
  const worst = depths.at(-1) ?? 0;
  const falseAlarms = judged.filter((v) => v.verdict === "worse").length;
  const recall = values as number[];
  return {
    runs: runs.length,
    cases: first.cases.length,
    claims: first.claims,
    recall: { values: recall, mean: mean(recall), sd: sampleSd(recall) },
    splits: judged.length,
    falseAlarms,
    lowerBound: { median: median(depths), worst },
    requiredMargin: Math.floor(worst * 100) + 1,
    passesAt: {
      margin: options.margin,
      splits: judged.filter((v) => v.verdict === "pass").length,
    },
    passed: falseAlarms === 0,
  };
}

// Every split of 0..k-1 into two halves, the first half holding run 0 so
// that a split and its mirror count once.
export function halves(k: number): Array<[number[], number[]]> {
  const size = k / 2;
  const out: Array<[number[], number[]]> = [];
  const pick = (start: number, chosen: number[]) => {
    if (chosen.length === size) {
      const rest = Array.from({ length: k }, (_, i) => i).filter((i) => !chosen.includes(i));
      out.push([chosen, rest]);
      return;
    }
    for (let i = start; i < k; i++) pick(i + 1, [...chosen, i]);
  };
  pick(1, [0]);
  return out;
}

function recallOf(run: SavedSummary): number | undefined {
  const cases = run.summary.golden?.cases;
  if (!cases) return undefined;
  let found = 0;
  let expected = 0;
  for (const c of Object.values(cases)) {
    const required = c.claims.filter((claim) => !claim.optional);
    expected += required.length;
    found += required.filter((claim) => claim.found).length;
  }
  return expected === 0 ? undefined : found / expected;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, v) => total + v, 0) / values.length;
}

function sampleSd(values: readonly number[]): number {
  const m = mean(values);
  return Math.sqrt(values.reduce((total, v) => total + (v - m) ** 2, 0) / (values.length - 1));
}

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function renderNoise(label: string, result: NoiseResult): string {
  if ("refused" in result) return `# Noise baseline ${label}\n\nNo baseline: ${result.refused}.\n`;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const pts = (v: number) => `${(v * 100).toFixed(1)} points`;
  const half = result.runs / 2;
  return `${[
    `# Noise baseline ${label}`,
    "",
    `**A/A check ${result.passed ? "passed" : "failed"}**: ${result.falseAlarms} of ${result.splits} splits into ${half} runs against ${half} called worse.`,
    "",
    `Golden recall over ${result.claims} required claim(s) in ${result.cases} case(s), per run: ${result.recall.values.map(pct).join(", ")}; mean ${pct(result.recall.mean)}, standard deviation ${pts(result.recall.sd)}.`,
    "",
    `The verdict's lower bound on an unchanged change, ${half} runs a side: median −${pts(result.lowerBound.median)}, worst −${pts(result.lowerBound.worst)}. At a margin of ${pts(result.passesAt.margin)}, ${result.passesAt.splits} of ${result.splits} splits pass; every split passes from a margin of ${result.requiredMargin} points.`,
  ].join("\n")}\n`;
}
