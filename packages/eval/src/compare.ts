import type { GoldenSummary } from "./golden-score.js";
import type { RunInfo } from "./report.js";
import type { Summary } from "./score.js";

export interface SavedSummary {
  info?: RunInfo;
  summary: Summary & { golden?: GoldenSummary };
}

// Differences that are not the change under test. Golden numbers depend on
// the cases and labels at scoring time, so rescore every run after labeling.
export function comparisonWarnings(runs: readonly SavedSummary[]): string[] {
  const differ = (pick: (s: SavedSummary) => unknown) =>
    new Set(runs.map((s) => JSON.stringify(pick(s) ?? null))).size > 1;
  const warnings: string[] = [];
  if (differ((s) => s.info?.judge)) warnings.push("the runs were scored by different judges");
  if (differ((s) => s.info?.selection.dataset ?? "aacr"))
    warnings.push("the runs use different datasets");
  // Summaries written before a field existed may lack it.
  if (differ((s) => s.summary.instances?.reviewed)) {
    warnings.push("the runs reviewed a different number of PRs (failed ones are not scored)");
  }
  if (differ((s) => s.summary.golden?.casesHash)) {
    warnings.push("the runs were scored against different golden cases or labels; rescore them");
  }
  if (runs.some((s) => (s.summary.golden?.counts.unadjudicated ?? 0) > 0)) {
    warnings.push("some findings are unlabeled, which lowers golden precision until labeled");
  }
  return warnings;
}

interface Metric {
  name: string;
  value(s: SavedSummary): number | undefined;
  higherIsBetter: boolean;
  percent: boolean;
}

const METRICS: Metric[] = [
  {
    name: "Precision",
    value: (s) => s.summary.overall.metrics.precision,
    higherIsBetter: true,
    percent: true,
  },
  {
    name: "Recall",
    value: (s) => s.summary.overall.metrics.recall,
    higherIsBetter: true,
    percent: true,
  },
  { name: "F1", value: (s) => s.summary.overall.metrics.f1, higherIsBetter: true, percent: true },
  {
    name: "Lenient precision (any line)",
    value: (s) => s.summary.overall.metrics.lenientPrecision,
    higherIsBetter: true,
    percent: true,
  },
  {
    name: "Lenient recall (any line)",
    value: (s) => s.summary.overall.metrics.lenientRecall,
    higherIsBetter: true,
    percent: true,
  },
  {
    name: "Golden precision",
    value: (s) => s.summary.golden?.precision,
    higherIsBetter: true,
    percent: true,
  },
  {
    name: "Golden recall",
    value: (s) => s.summary.golden?.recall,
    higherIsBetter: true,
    percent: true,
  },
  {
    name: "Golden failures",
    value: (s) => s.summary.golden?.failures.length,
    higherIsBetter: false,
    percent: false,
  },
  {
    name: "Cost per reviewed PR ($)",
    value: (s) => s.summary.costPerReviewedUsd,
    higherIsBetter: false,
    percent: false,
  },
  {
    name: "Median seconds per PR",
    value: (s) => s.summary.durationSeconds.median,
    higherIsBetter: false,
    percent: false,
  },
];

export interface ComparisonRow {
  metric: string;
  baseline: number;
  run: number;
  difference: number;
  spread?: number;
  verdict: "better" | "worse" | "no change" | "unknown";
  percent: boolean;
}

// ADR-0011: a small set cannot show small effects. With a second baseline
// run, a difference no larger than the spread between the two baselines is
// reported as no change; without one, the direction is not judged.
export function compareSummaries(
  baseline: SavedSummary,
  run: SavedSummary,
  otherBaseline?: SavedSummary,
): ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  for (const metric of METRICS) {
    const a = metric.value(baseline);
    const b = metric.value(run);
    if (a === undefined || b === undefined) continue;
    const other = otherBaseline ? metric.value(otherBaseline) : undefined;
    const spread = other === undefined ? undefined : Math.abs(a - other);
    const difference = b - a;
    const verdict =
      spread === undefined
        ? "unknown"
        : Math.abs(difference) <= spread
          ? "no change"
          : difference > 0 === metric.higherIsBetter
            ? "better"
            : "worse";
    rows.push({
      metric: metric.name,
      baseline: a,
      run: b,
      difference,
      ...(spread === undefined ? {} : { spread }),
      verdict,
      percent: metric.percent,
    });
  }
  return rows;
}

export function renderComparison(
  rows: readonly ComparisonRow[],
  warnings: readonly string[],
): string {
  const format = (value: number, percent: boolean) =>
    percent ? `${(value * 100).toFixed(1)}%` : value.toFixed(value < 10 ? 4 : 1);
  const signed = (value: number, percent: boolean) =>
    `${value >= 0 ? "+" : ""}${format(value, percent)}`;
  return [
    "| Metric | Baseline | Run | Difference | Spread | Verdict |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.metric} | ${format(r.baseline, r.percent)} | ${format(r.run, r.percent)} | ${signed(r.difference, r.percent)} | ${r.spread === undefined ? "not measured" : format(r.spread, r.percent)} | ${r.verdict} |`,
    ),
    ...warnings.map((w) => `\nWarning: ${w}`),
    "",
  ].join("\n");
}
