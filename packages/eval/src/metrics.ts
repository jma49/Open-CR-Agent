import type { ReferenceMatch } from "./match.js";

export interface Counts {
  expected: number;
  generated: number;
  lineMatches: number;
  semanticMatches: number;
}

export interface QualityMetrics {
  precision: number;
  recall: number;
  f1: number;
  linePrecision: number;
  lineRecall: number;
}

export function countMatches(matches: readonly ReferenceMatch[], generated: number): Counts {
  return {
    expected: matches.length,
    generated,
    lineMatches: matches.filter((m) => m.lineMatch).length,
    semanticMatches: matches.filter((m) => m.semanticMatch).length,
  };
}

export function addCounts(a: Counts, b: Counts): Counts {
  return {
    expected: a.expected + b.expected,
    generated: a.generated + b.generated,
    lineMatches: a.lineMatches + b.lineMatches,
    semanticMatches: a.semanticMatches + b.semanticMatches,
  };
}

export function emptyCounts(): Counts {
  return { expected: 0, generated: 0, lineMatches: 0, semanticMatches: 0 };
}

export function qualityMetrics(c: Counts): QualityMetrics {
  const precision = ratio(c.semanticMatches, c.generated);
  const recall = ratio(c.semanticMatches, c.expected);
  return {
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    linePrecision: ratio(c.lineMatches, c.generated),
    lineRecall: ratio(c.lineMatches, c.expected),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
