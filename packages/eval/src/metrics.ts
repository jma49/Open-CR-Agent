import type { ReferenceMatch } from "./match.js";

export interface Counts {
  expected: number;
  generated: number;
  lineMatches: number;
  semanticMatches: number;
  // Same concern in the same file at any line (diagnostic).
  lenientMatches: number;
}

export interface QualityMetrics {
  precision: number;
  recall: number;
  f1: number;
  linePrecision: number;
  lineRecall: number;
  lenientPrecision: number;
  lenientRecall: number;
}

export function countMatches(
  matches: readonly ReferenceMatch[],
  generated: number,
  lenient: readonly ReferenceMatch[] = [],
): Counts {
  const semanticMatches = matches.filter((m) => m.semanticMatch).length;
  return {
    expected: matches.length,
    generated,
    lineMatches: matches.filter((m) => m.lineMatch).length,
    semanticMatches,
    // Greedy matching can pair differently without the line stage; never
    // report fewer than the official matches.
    lenientMatches: Math.max(semanticMatches, lenient.filter((m) => m.semanticMatch).length),
  };
}

export function addCounts(a: Counts, b: Counts): Counts {
  return {
    expected: a.expected + b.expected,
    generated: a.generated + b.generated,
    lineMatches: a.lineMatches + b.lineMatches,
    semanticMatches: a.semanticMatches + b.semanticMatches,
    lenientMatches: a.lenientMatches + b.lenientMatches,
  };
}

export function emptyCounts(): Counts {
  return { expected: 0, generated: 0, lineMatches: 0, semanticMatches: 0, lenientMatches: 0 };
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
    lenientPrecision: ratio(c.lenientMatches, c.generated),
    lenientRecall: ratio(c.lenientMatches, c.expected),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
