// A 95% confidence interval for the mean of k repeated runs: the Student t
// interval, mean ± t(0.975, k-1) · s / √k, with s the sample standard
// deviation. It assumes the runs' numbers vary roughly normally around the
// true mean; with few runs it is wide, which is the point.
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

// One-sided 80% quantiles of Student's t by degrees of freedom, for the
// power term of the detectable difference; beyond 30 the value for 30.
const T_80 = [
  1.376, 1.061, 0.978, 0.941, 0.92, 0.906, 0.896, 0.889, 0.883, 0.879, 0.876, 0.873, 0.87, 0.868,
  0.866, 0.865, 0.863, 0.862, 0.861, 0.86, 0.859, 0.858, 0.858, 0.857, 0.856, 0.856, 0.855, 0.855,
  0.854, 0.854,
];

export interface TwoSampleTest {
  // The run side's mean minus the baseline's.
  difference: number;
  degreesOfFreedom: number;
  // A difference larger than this is significant (two-sided, α = 0.05).
  critical: number;
  // The smallest true difference found with power 0.8 at that level: a
  // smaller one is mostly called "no change", so "no change" means at most
  // about this much.
  detectable: number;
}

// Student's two-sample t test with the pooled standard deviation of both
// sides' runs. Undefined unless each side has two runs.
export function twoSampleTest(
  baseline: readonly number[],
  run: readonly number[],
): TwoSampleTest | undefined {
  const a = baseline.length;
  const b = run.length;
  if (a < 2 || b < 2) return undefined;
  const degreesOfFreedom = a + b - 2;
  const pooled = Math.sqrt(
    ((a - 1) * variance(baseline) + (b - 1) * variance(run)) / degreesOfFreedom,
  );
  const standardError = pooled * Math.sqrt(1 / a + 1 / b);
  const t80 = T_80[Math.min(degreesOfFreedom, T_80.length) - 1] ?? Number.NaN;
  return {
    difference: meanOf(run) - meanOf(baseline),
    degreesOfFreedom,
    critical: tQuantile(degreesOfFreedom) * standardError,
    detectable: (tQuantile(degreesOfFreedom) + t80) * standardError,
  };
}

export function testVerdict(
  test: TwoSampleTest,
  higherIsBetter: boolean,
): "better" | "worse" | "no change" {
  if (Math.abs(test.difference) <= test.critical) return "no change";
  return test.difference > 0 === higherIsBetter ? "better" : "worse";
}

function meanOf(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function variance(values: readonly number[]): number {
  const mean = meanOf(values);
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
}
