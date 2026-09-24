export interface QualityMetrics {
  precision: number;
  recall: number;
  f1: number;
}

export function computeMetrics(
  truePositives: number,
  reported: number,
  expected: number,
): QualityMetrics {
  const precision = reported === 0 ? 0 : truePositives / reported;
  const recall = expected === 0 ? 0 : truePositives / expected;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}
