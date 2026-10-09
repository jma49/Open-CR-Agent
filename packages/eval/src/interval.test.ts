import { describe, expect, it } from "vitest";
import { confidenceInterval, testVerdict, tQuantile, twoSampleTest } from "./interval.js";

describe("confidenceInterval", () => {
  it("is the Student t interval of the mean", () => {
    // Mean 0.4, sample standard deviation 0.1, t(0.975, 2) = 4.303.
    const interval = confidenceInterval([0.3, 0.4, 0.5]);
    const half = (4.303 * 0.1) / Math.sqrt(3);
    expect(interval?.mean).toBeCloseTo(0.4, 12);
    expect(interval?.low).toBeCloseTo(0.4 - half, 12);
    expect(interval?.high).toBeCloseTo(0.4 + half, 12);
    expect(interval?.n).toBe(3);
  });

  it("has no width when every run agrees, and needs two runs", () => {
    expect(confidenceInterval([0.5, 0.5])).toEqual({ mean: 0.5, low: 0.5, high: 0.5, n: 2 });
    expect(confidenceInterval([0.5])).toBeUndefined();
    expect(confidenceInterval([])).toBeUndefined();
  });

  it("uses the t quantile for 30 degrees of freedom beyond 30", () => {
    expect(tQuantile(1)).toBe(12.706);
    expect(tQuantile(30)).toBe(2.042);
    expect(tQuantile(100)).toBe(2.042);
  });
});

describe("twoSampleTest", () => {
  it("reports a known difference", () => {
    const test = twoSampleTest([0.2, 0.22, 0.18], [0.4, 0.42, 0.38]);
    expect(test?.difference).toBeCloseTo(0.2, 12);
    expect(test && testVerdict(test, true)).toBe("better");
    expect(test && testVerdict(test, false)).toBe("worse");
  });

  it("gives identical-looking sides the difference it could have detected", () => {
    // Recall 2/18–3/18 on both sides, as measured for #470 on 2026-10-08:
    // pooled SD 0.0321, df 4, (2.776 + 0.941) · 0.0321 · √(2/3).
    const test = twoSampleTest([2 / 18, 3 / 18, 3 / 18], [2 / 18, 2 / 18, 3 / 18]);
    expect(test && testVerdict(test, true)).toBe("no change");
    const sd = Math.sqrt((2 * (1 / 18) ** 2) / 3 / 2);
    expect(test?.detectable).toBeCloseTo((2.776 + 0.941) * sd * Math.sqrt(2 / 3), 12);
    expect(test?.detectable).toBeGreaterThan(0.09);
  });

  it("needs two runs on each side", () => {
    expect(twoSampleTest([0.2], [0.3, 0.4])).toBeUndefined();
  });
});
