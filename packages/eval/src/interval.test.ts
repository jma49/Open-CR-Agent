import { describe, expect, it } from "vitest";
import { confidenceInterval, intervalVerdict, tQuantile } from "./interval.js";

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

describe("intervalVerdict", () => {
  const at = (low: number, high: number) => ({ mean: (low + high) / 2, low, high, n: 3 });

  it("calls a change only when the intervals do not overlap", () => {
    expect(intervalVerdict(at(0.2, 0.3), at(0.35, 0.4), true)).toBe("better");
    expect(intervalVerdict(at(0.2, 0.3), at(0.35, 0.4), false)).toBe("worse");
    expect(intervalVerdict(at(0.35, 0.4), at(0.2, 0.3), true)).toBe("worse");
    expect(intervalVerdict(at(0.2, 0.3), at(0.29, 0.5), true)).toBe("no change");
  });
});
