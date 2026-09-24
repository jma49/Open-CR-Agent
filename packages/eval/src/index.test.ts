import { describe, expect, it } from "vitest";
import { computeMetrics } from "./index.js";

describe("computeMetrics", () => {
  it("computes precision, recall and f1", () => {
    const m = computeMetrics(6, 8, 12);
    expect(m.precision).toBeCloseTo(0.75);
    expect(m.recall).toBeCloseTo(0.5);
    expect(m.f1).toBeCloseTo(0.6);
  });

  it("returns zeros when nothing is reported or expected", () => {
    expect(computeMetrics(0, 0, 0)).toEqual({ precision: 0, recall: 0, f1: 0 });
  });
});
