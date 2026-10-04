// A 95% confidence interval for the mean of k repeated runs: the Student t
// interval, mean ± t(0.975, k-1) · s / √k, with s the sample standard
// deviation. It assumes the runs' numbers vary roughly normally around the
// true mean; with few runs it is wide, which is the point: a difference
// counts only when the intervals of two setups do not overlap.
export interface Interval {
  mean: number;
  low: number;
  high: number;
  n: number;
}

// Two-sided 95% quantiles of Student's t by degrees of freedom; beyond 30
// the value for 30 is used, which only widens the interval slightly.
const T_975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];

export function tQuantile(degreesOfFreedom: number): number {
  return T_975[Math.min(degreesOfFreedom, T_975.length) - 1] ?? Number.NaN;
}

// Undefined for fewer than two values: one run has no spread to measure.
export function confidenceInterval(values: readonly number[]): Interval | undefined {
  const n = values.length;
  if (n < 2) return undefined;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
  const half = tQuantile(n - 1) * Math.sqrt(variance / n);
  return { mean, low: mean - half, high: mean + half, n };
}

// "better" or "worse" only when the intervals do not overlap.
export function intervalVerdict(
  baseline: Interval,
  run: Interval,
  higherIsBetter: boolean,
): "better" | "worse" | "no change" {
  if (run.low > baseline.high) return higherIsBetter ? "better" : "worse";
  if (run.high < baseline.low) return higherIsBetter ? "worse" : "better";
  return "no change";
}
