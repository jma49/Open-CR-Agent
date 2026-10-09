import type { SavedSummary } from "./compare.js";
import type { GoldenCaseScore } from "./golden-score.js";
import { concernCell } from "./trend.js";

// A golden comparison claim by claim. Recall moves by whole expected
// findings, so on a small tier the per-run numbers are coarse; pairing each
// expected finding with itself across the two sides uses every repeat.

interface ClaimHits {
  hits: number;
  runs: number;
}

interface ClaimRow {
  id: string;
  concern: string;
  baseline: ClaimHits;
  run: ClaimHits;
}

interface SignTest {
  // Claims found in a larger or smaller share of the run side's repeats.
  better: number;
  worse: number;
  tied: number;
  // Two-sided exact binomial p of the better/worse split.
  pValue: number;
  verdict: "better" | "worse" | "no change";
}

export interface ClaimComparison {
  // Claims whose hit rate differs between the sides.
  differing: ClaimRow[];
  claims: number;
  test?: SignTest;
  // Why there is no paired test.
  refused?: string;
}

// Undefined unless every run on both sides has per-case golden scores.
export function compareClaims(
  baselines: readonly SavedSummary[],
  runs: readonly SavedSummary[],
): ClaimComparison | undefined {
  const all = [...baselines, ...runs];
  const cases = all.map((s) => s.summary.golden?.cases);
  if (cases.some((c) => c === undefined || Object.keys(c).length === 0)) return undefined;
  const hashes = new Set(all.map((s) => s.summary.golden?.casesHash));
  if (hashes.size > 1) {
    return {
      differing: [],
      claims: 0,
      refused: "the runs were scored against different golden cases or labels",
    };
  }
  const scored = cases as Record<string, GoldenCaseScore>[];
  const common = Object.keys(scored[0] ?? {})
    .filter((id) => scored.every((c) => id in c))
    .sort();
  const side = (summaries: readonly SavedSummary[], id: string, k: number): ClaimHits => ({
    hits: summaries.filter((s) => s.summary.golden?.cases?.[id]?.claims[k]?.found === true).length,
    runs: summaries.length,
  });
  const rows: ClaimRow[] = common.flatMap((id) =>
    (scored[0]?.[id]?.claims ?? []).map((claim, k) => ({
      id: `${id}#${k + 1}`,
      concern: claim.concern,
      baseline: side(baselines, id, k),
      run: side(runs, id, k),
    })),
  );
  const rate = (h: ClaimHits) => h.hits / h.runs;
  const differing = rows.filter((r) => rate(r.run) !== rate(r.baseline));
  const better = differing.filter((r) => rate(r.run) > rate(r.baseline)).length;
  const worse = differing.length - better;
  const pValue = signTestP(better, worse);
  return {
    differing,
    claims: rows.length,
    test: {
      better,
      worse,
      tied: rows.length - differing.length,
      pValue,
      verdict: pValue >= 0.05 ? "no change" : better > worse ? "better" : "worse",
    },
  };
}

// P(a split at least this uneven) for n fair coin flips, both tails.
export function signTestP(better: number, worse: number): number {
  const n = better + worse;
  if (n === 0) return 1;
  const tail = Math.min(better, worse);
  // In logs: 2^-n underflows for long lists.
  let logP = -n * Math.LN2;
  let sum = 0;
  for (let i = 0; i <= tail; i++) {
    sum += Math.exp(logP);
    logP += Math.log((n - i) / (i + 1));
  }
  return Math.min(1, 2 * sum);
}

export function renderClaimComparison(comparison: ClaimComparison): string {
  const lines = ["", "## Expected findings, paired", ""];
  if (comparison.refused) {
    lines.push(`No paired test: ${comparison.refused}; rescore both sides.`, "");
    return lines.join("\n");
  }
  const t = comparison.test;
  if (t) {
    lines.push(
      `Sign test over the ${comparison.claims} expected finding(s) of the cases every run reviewed: ${t.better} found more often by the run, ${t.worse} less often, ${t.tied} as often; two-sided p = ${t.pValue.toFixed(3)}: ${t.verdict}.`,
      "",
    );
  }
  if (comparison.differing.length > 0) {
    const cell = (h: ClaimHits) => `${h.hits}/${h.runs}`;
    lines.push(
      "| Claim | Concern | Baseline | Run |",
      "|---|---|---|---|",
      ...comparison.differing.map(
        (r) => `| ${r.id} | ${concernCell(r.concern)} | ${cell(r.baseline)} | ${cell(r.run)} |`,
      ),
      "",
    );
  }
  return lines.join("\n");
}
