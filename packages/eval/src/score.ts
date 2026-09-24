import type { Finding, Usage } from "@open-cr-agent/core";
import type { Instance } from "./dataset.js";
import {
  type GeneratedComment,
  matchComments,
  type ReferenceMatch,
  type SemanticJudge,
} from "./match.js";
import {
  addCounts,
  type Counts,
  countMatches,
  emptyCounts,
  type QualityMetrics,
  qualityMetrics,
} from "./metrics.js";
import type { InstanceResult } from "./runner.js";

export interface Scored {
  counts: Counts;
  metrics: QualityMetrics;
}

export interface Summary {
  instances: {
    selected: number;
    reviewed: number;
    failed: number;
    unavailable: number;
    skippedBudget: number;
  };
  overall: Scored;
  byLanguage: Record<string, Scored>;
  recallByCategory: Record<string, { expected: number; matched: number; recall: number }>;
  recallByContext: Record<string, { expected: number; matched: number; recall: number }>;
  usage: Usage;
  costPerReviewedUsd: number;
  durationSeconds: { median: number; p90: number };
}

export function toGeneratedComment(finding: Finding): GeneratedComment {
  return {
    path: finding.file,
    side: "right",
    fromLine: finding.lineRange?.start ?? null,
    toLine: finding.lineRange?.end ?? null,
    note: `${finding.title}\n\n${finding.body}`,
  };
}

// Only reviewed instances are scored, so a failed or skipped PR cannot pass as
// a clean review; failures are reported separately.
export async function score(
  instances: readonly Instance[],
  results: readonly InstanceResult[],
  judge: SemanticJudge,
): Promise<Summary> {
  const byId = new Map(results.map((r) => [r.id, r]));
  const reviewed = instances.filter((i) => byId.get(i.id)?.status === "reviewed");

  let overall = emptyCounts();
  const languages = new Map<string, Counts>();
  const allMatches: ReferenceMatch[] = [];
  for (const instance of reviewed) {
    const findings = byId.get(instance.id)?.findings ?? [];
    const matches = await matchComments(
      instance.references,
      findings.map(toGeneratedComment),
      judge,
    );
    const counts = countMatches(matches, findings.length);
    overall = addCounts(overall, counts);
    languages.set(
      instance.language,
      addCounts(languages.get(instance.language) ?? emptyCounts(), counts),
    );
    allMatches.push(...matches);
  }

  const reviewedResults = results.filter((r) => r.status === "reviewed");
  const durations = reviewedResults.map((r) => r.durationMs / 1000).sort((a, b) => a - b);
  const usage = results.reduce(
    (total, r) => ({
      inputTokens: total.inputTokens + r.usage.inputTokens,
      outputTokens: total.outputTokens + r.usage.outputTokens,
      reasoningTokens: total.reasoningTokens + r.usage.reasoningTokens,
      cachedTokens: total.cachedTokens + r.usage.cachedTokens,
      costUsd: total.costUsd + r.usage.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 },
  );

  return {
    instances: {
      selected: instances.length,
      reviewed: reviewed.length,
      failed: results.filter((r) => r.status === "failed").length,
      unavailable: results.filter((r) => r.status === "unavailable").length,
      skippedBudget: results.filter((r) => r.status === "skipped_budget").length,
    },
    overall: { counts: overall, metrics: qualityMetrics(overall) },
    byLanguage: Object.fromEntries(
      [...languages]
        .sort()
        .map(([language, counts]) => [language, { counts, metrics: qualityMetrics(counts) }]),
    ),
    recallByCategory: recallBy(allMatches, (m) => m.reference.category),
    recallByContext: recallBy(allMatches, (m) => m.reference.context),
    usage,
    costPerReviewedUsd: reviewedResults.length === 0 ? 0 : usage.costUsd / reviewedResults.length,
    durationSeconds: { median: percentile(durations, 0.5), p90: percentile(durations, 0.9) },
  };
}

function recallBy(matches: readonly ReferenceMatch[], key: (m: ReferenceMatch) => string) {
  const groups = new Map<string, { expected: number; matched: number }>();
  for (const match of matches) {
    const group = groups.get(key(match)) ?? { expected: 0, matched: 0 };
    group.expected += 1;
    if (match.semanticMatch) group.matched += 1;
    groups.set(key(match), group);
  }
  return Object.fromEntries(
    [...groups]
      .sort()
      .map(([name, g]) => [name, { ...g, recall: g.expected === 0 ? 0 : g.matched / g.expected }]),
  );
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
}
