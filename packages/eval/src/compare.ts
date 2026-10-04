import { confidenceInterval, type Interval, intervalVerdict } from "./interval.js";
import { provenanceWarnings } from "./provenance.js";
import type { RunInfo, RunSummary } from "./report.js";

export interface SavedSummary {
  info?: RunInfo;
  summary: RunSummary;
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
  return [...warnings, ...provenanceWarnings(runs.map((s) => s.summary.provenance))];
}

export interface Metric {
  name: string;
  value(s: SavedSummary): number | undefined;
  higherIsBetter: boolean;
  percent: boolean;
  // Repeated runs report a confidence interval for it, and compare by it.
  interval?: true;
}

export const METRICS: Metric[] = [
  {
    name: "Precision",
    value: (s) => s.summary.overall.metrics.precision,
    higherIsBetter: true,
    percent: true,
    interval: true,
  },
  {
    name: "Recall",
    value: (s) => s.summary.overall.metrics.recall,
    higherIsBetter: true,
    percent: true,
    interval: true,
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
    interval: true,
  },
  {
    name: "Golden recall",
    value: (s) => s.summary.golden?.recall,
    higherIsBetter: true,
    percent: true,
    interval: true,
  },
  {
    name: "Golden failures",
    value: (s) => s.summary.golden?.failures.length,
    higherIsBetter: false,
    percent: false,
  },
  {
    name: "File-level findings (share)",
    value: (s) => s.summary.anchoring?.fileLevelShare,
    higherIsBetter: false,
    percent: true,
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
  // Repeated runs on both sides: 95% intervals of each side's mean.
  baselineInterval?: Interval;
  runInterval?: Interval;
  verdict: "better" | "worse" | "no change" | "unknown";
  percent: boolean;
}

// ADR-0011: a small set cannot show small effects. Repeated runs on both
// sides compare by confidence interval: a difference counts only when the
// intervals do not overlap. Otherwise, with a second baseline run, a
// difference no larger than the spread between the two baselines is no
// change; without either, the direction is not judged. A repeated side is
// shown by its mean.
export function compareSummaries(
  baseline: SavedSummary | readonly SavedSummary[],
  run: SavedSummary | readonly SavedSummary[],
  otherBaseline?: SavedSummary,
): ComparisonRow[] {
  const baselines = asList(baseline);
  const runs = asList(run);
  const rows: ComparisonRow[] = [];
  for (const metric of METRICS) {
    const before = values(metric, baselines);
    const after = values(metric, runs);
    if (!before || !after) continue;
    const a = mean(before);
    const b = mean(after);
    const other = otherBaseline ? metric.value(otherBaseline) : undefined;
    const spread = other === undefined ? undefined : Math.abs(a - other);
    const intervals = metric.interval
      ? { baseline: confidenceInterval(before), run: confidenceInterval(after) }
      : undefined;
    const difference = b - a;
    const verdict =
      intervals?.baseline && intervals.run
        ? intervalVerdict(intervals.baseline, intervals.run, metric.higherIsBetter)
        : spread === undefined
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
      ...(intervals?.baseline && intervals.run
        ? { baselineInterval: intervals.baseline, runInterval: intervals.run }
        : {}),
      verdict,
      percent: metric.percent,
    });
  }
  return rows;
}

function asList(s: SavedSummary | readonly SavedSummary[]): readonly SavedSummary[] {
  return "summary" in s ? [s] : s;
}

// Every run's value, or undefined when any run lacks the metric.
function values(metric: Metric, runs: readonly SavedSummary[]): number[] | undefined {
  const all = runs.map((s) => metric.value(s));
  return all.length > 0 && all.every((v) => v !== undefined) ? (all as number[]) : undefined;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function formatValue(value: number, percent: boolean): string {
  return percent ? `${(value * 100).toFixed(1)}%` : value.toFixed(value < 10 ? 4 : 1);
}

export function formatInterval(interval: Interval, percent: boolean): string {
  return `${formatValue(interval.low, percent)} to ${formatValue(interval.high, percent)}`;
}

export function renderComparison(
  rows: readonly ComparisonRow[],
  warnings: readonly string[],
): string {
  const format = formatValue;
  const signed = (value: number, percent: boolean) =>
    `${value >= 0 ? "+" : ""}${format(value, percent)}`;
  const intervals = rows.some((r) => r.runInterval);
  const ci = (r: ComparisonRow) =>
    !intervals
      ? ""
      : r.baselineInterval && r.runInterval
        ? ` ${formatInterval(r.baselineInterval, r.percent)} | ${formatInterval(r.runInterval, r.percent)} |`
        : " – | – |";
  return [
    `| Metric | Baseline | Run | Difference | Spread |${intervals ? " 95% CI, baseline | 95% CI, run |" : ""} Verdict |`,
    `|---|---|---|---|---|${intervals ? "---|---|" : ""}---|`,
    ...rows.map(
      (r) =>
        `| ${r.metric} | ${format(r.baseline, r.percent)} | ${format(r.run, r.percent)} | ${signed(r.difference, r.percent)} | ${r.spread === undefined ? "not measured" : format(r.spread, r.percent)} |${ci(r)} ${r.verdict} |`,
    ),
    ...warnings.map((w) => `\nWarning: ${w}`),
    "",
  ].join("\n");
}
