import type { SavedSummary } from "./compare.js";
import { lacksClaimIds } from "./golden-score.js";

// The merge verdict on golden recall (eval plan §2, to become ADR-0035).
// Cases are the unit that was sampled, so the interval resamples cases, not
// claims or runs: each case enters with its mean over each side's repeats,
// paired with itself. A sign test over the per-case differences can veto a
// pass that a few large gains would otherwise carry.

export interface VerdictOptions {
  // The largest recall loss (a share, 0.10 = 10 points) a change may carry
  // and still pass: the lower bound must stay above -margin.
  margin: number;
  // A cost ratio above this passes only if the PR names the trade-off.
  maxCostRatio: number;
  resamples: number;
  seed: number;
}

export const DEFAULT_VERDICT: VerdictOptions = {
  margin: 0.1,
  maxCostRatio: 1.25,
  resamples: 10_000,
  seed: 1,
};

export interface CaseRecall {
  id: string;
  // Required claims: the same on both sides, since both share casesHash.
  expected: number;
  // Mean claims found per run.
  baseline: number;
  run: number;
}

interface RecallVerdict {
  cases: CaseRecall[];
  claims: number;
  baselineRecall: number;
  runRecall: number;
  difference: number;
  // One-sided 97.5% bounds of the difference, from the case bootstrap.
  lower: number;
  upper: number;
  signTest: { better: number; worse: number; tied: number; pWorse: number };
  // Mean cost per reviewed PR, run side over baseline; absent when the
  // baseline cost nothing.
  costRatio?: number;
  verdict: "pass" | "worse" | "inconclusive";
  reasons: string[];
}

export type VerdictResult = RecallVerdict | { refused: string };

export function recallVerdict(
  baselines: readonly SavedSummary[],
  runs: readonly SavedSummary[],
  options: VerdictOptions = DEFAULT_VERDICT,
): VerdictResult {
  const refused = refusal(baselines, runs);
  if (refused) return { refused };
  const cases = caseRecalls(baselines, runs);
  if (cases.length === 0) return { refused: "no case with required claims is common to every run" };
  const claims = sum(cases.map((c) => c.expected));
  const baselineRecall = sum(cases.map((c) => c.baseline)) / claims;
  const runRecall = sum(cases.map((c) => c.run)) / claims;
  const { lower, upper } = bootstrapBounds(cases, options);
  const signTest = caseSignTest(cases);
  const costRatio = ratio(meanCost(runs), meanCost(baselines));
  const reasons: string[] = [];
  let verdict: RecallVerdict["verdict"];
  if (signTest.worse > signTest.better && signTest.pWorse < 0.05) {
    verdict = "worse";
    reasons.push(
      `more cases got worse than better (${signTest.worse} to ${signTest.better}, one-sided p = ${signTest.pWorse.toFixed(3)})`,
    );
  } else if (upper < -options.margin) {
    verdict = "worse";
    reasons.push(`the whole interval lies below -${points(options.margin)}`);
  } else if (lower > -options.margin) {
    verdict = "pass";
    reasons.push(`the lower bound ${points(lower)} is above -${points(options.margin)}`);
  } else {
    verdict = "inconclusive";
    reasons.push(
      `the lower bound ${points(lower)} is not above -${points(options.margin)}: run more repeats on both sides`,
    );
  }
  if (verdict === "pass" && costRatio !== undefined && costRatio > options.maxCostRatio) {
    reasons.push(
      `cost per PR is ${costRatio.toFixed(2)}× the baseline's, above ${options.maxCostRatio}×: the PR names the trade-off`,
    );
  }
  return {
    cases,
    claims,
    baselineRecall,
    runRecall,
    difference: runRecall - baselineRecall,
    lower,
    upper,
    signTest,
    ...(costRatio === undefined ? {} : { costRatio }),
    verdict,
    reasons,
  };
}

function refusal(
  baselines: readonly SavedSummary[],
  runs: readonly SavedSummary[],
): string | undefined {
  if (baselines.length === 0 || runs.length === 0) return "each side needs at least one run";
  const all = [...baselines, ...runs];
  const golden = all.map((s) => s.summary.golden);
  if (golden.some((g) => g?.cases === undefined)) {
    return "some runs have no per-case golden scores; rescore them";
  }
  if (golden.some((g) => lacksClaimIds(g?.cases))) {
    return "some runs were scored before claims had ids; rescore them";
  }
  if (new Set(golden.map((g) => g?.casesHash)).size > 1) {
    return "the runs were scored against different golden cases or labels; rescore them";
  }
  return undefined;
}

function caseRecalls(
  baselines: readonly SavedSummary[],
  runs: readonly SavedSummary[],
): CaseRecall[] {
  const all = [...baselines, ...runs];
  const ids = Object.keys(all[0]?.summary.golden?.cases ?? {})
    .filter((id) => all.every((s) => s.summary.golden?.cases?.[id] !== undefined))
    .sort();
  const found = (s: SavedSummary, id: string) =>
    s.summary.golden?.cases?.[id]?.claims.filter((c) => c.found && !c.optional).length ?? 0;
  const meanFound = (side: readonly SavedSummary[], id: string) =>
    sum(side.map((s) => found(s, id))) / side.length;
  return ids.flatMap((id) => {
    const expected = all[0]?.summary.golden?.cases?.[id]?.expected ?? 0;
    return expected > 0
      ? [{ id, expected, baseline: meanFound(baselines, id), run: meanFound(runs, id) }]
      : [];
  });
}

// Percentile bounds of the pooled recall difference over case resamples.
export function bootstrapBounds(
  cases: readonly CaseRecall[],
  options: Pick<VerdictOptions, "resamples" | "seed">,
): { lower: number; upper: number } {
  const random = mulberry32(options.seed);
  const differences = new Float64Array(options.resamples);
  for (let r = 0; r < options.resamples; r++) {
    let gained = 0;
    let expected = 0;
    for (let i = 0; i < cases.length; i++) {
      const c = cases[Math.floor(random() * cases.length)] as CaseRecall;
      gained += c.run - c.baseline;
      expected += c.expected;
    }
    differences[r] = gained / expected;
  }
  differences.sort();
  const at = (q: number) =>
    differences[Math.min(options.resamples - 1, Math.max(0, Math.floor(q * options.resamples)))] ??
    0;
  return { lower: at(0.025), upper: at(0.975) };
}

function caseSignTest(cases: readonly CaseRecall[]): RecallVerdict["signTest"] {
  const better = cases.filter((c) => c.run > c.baseline).length;
  const worse = cases.filter((c) => c.run < c.baseline).length;
  return { better, worse, tied: cases.length - better - worse, pWorse: upperTailP(worse, better) };
}

// P(at least `worse` of `worse + better` fair coin flips land "worse").
export function upperTailP(worse: number, better: number): number {
  const n = worse + better;
  if (n === 0) return 1;
  let total = 0;
  for (let k = worse; k <= n; k++) total += Math.exp(logChoose(n, k) - n * Math.LN2);
  return Math.min(1, total);
}

function logChoose(n: number, k: number): number {
  let log = 0;
  for (let i = 1; i <= k; i++) log += Math.log((n - k + i) / i);
  return log;
}

// A small seeded generator: the same runs give the same bounds every time.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function meanCost(side: readonly SavedSummary[]): number {
  return sum(side.map((s) => s.summary.costPerReviewedUsd)) / side.length;
}

function ratio(a: number, b: number): number | undefined {
  return b === 0 ? undefined : a / b;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

function points(share: number): string {
  return `${(share * 100).toFixed(1)} points`;
}

export function renderVerdict(result: VerdictResult): string {
  if ("refused" in result) return `# Verdict\n\nNo verdict: ${result.refused}.\n`;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const t = result.signTest;
  const lines = [
    "# Verdict",
    "",
    `**${result.verdict}**: ${result.reasons.join("; ")}.`,
    "",
    `Golden recall over ${result.claims} required claim(s) in ${result.cases.length} case(s) common to every run: baseline ${pct(result.baselineRecall)}, run ${pct(result.runRecall)}, difference ${pct(result.difference)} (case bootstrap, one-sided 97.5% bounds ${pct(result.lower)} to ${pct(result.upper)}).`,
    "",
    `Cases: ${t.better} better, ${t.worse} worse, ${t.tied} tied (sign test, one-sided p of that many worse = ${t.pWorse.toFixed(3)}).`,
  ];
  if (result.costRatio !== undefined) {
    lines.push("", `Cost per reviewed PR: ${result.costRatio.toFixed(2)}× the baseline's.`);
  }
  const changed = result.cases.filter((c) => c.run !== c.baseline);
  if (changed.length > 0) {
    const cell = (found: number, expected: number) => `${found.toFixed(2)} / ${expected}`;
    lines.push(
      "",
      "| Case | Baseline found | Run found |",
      "|---|---|---|",
      ...changed.map(
        (c) => `| ${c.id} | ${cell(c.baseline, c.expected)} | ${cell(c.run, c.expected)} |`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}
