import type { GoldenSummary } from "./golden-score.js";
import type { Summary } from "./score.js";

export interface SavedSummary {
  summary: Summary & { golden?: GoldenSummary };
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
