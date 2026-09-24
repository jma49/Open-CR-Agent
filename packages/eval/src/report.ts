import type { Summary } from "./score.js";

export interface RunInfo {
  runId: string;
  createdAt: string;
  selection: Record<string, unknown>;
  models: Record<string, string | undefined>;
  judge: string;
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

export function renderMarkdown(info: RunInfo, summary: Summary): string {
  const { counts, metrics } = summary.overall;
  const lines = [
    `# AACR-Bench run ${info.runId}`,
    "",
    `- Date: ${info.createdAt}`,
    `- Selection: ${JSON.stringify(info.selection)}`,
    `- Models: ${JSON.stringify(info.models)}`,
    `- Judge: ${info.judge}`,
    `- Instances: ${summary.instances.reviewed} reviewed, ${summary.instances.failed} failed, ${summary.instances.skippedBudget} skipped for budget (of ${summary.instances.selected})`,
    "",
    "## Quality",
    "",
    "| Precision | Recall | F1 | Line precision | Line recall | Generated | Expected | Matched |",
    "|---|---|---|---|---|---|---|---|",
    `| ${pct(metrics.precision)} | ${pct(metrics.recall)} | ${pct(metrics.f1)} | ${pct(metrics.linePrecision)} | ${pct(metrics.lineRecall)} | ${counts.generated} | ${counts.expected} | ${counts.semanticMatches} |`,
    "",
    "## Cost and latency",
    "",
    `- Total $${summary.usage.costUsd.toFixed(4)}, $${summary.costPerReviewedUsd.toFixed(4)} per reviewed PR`,
    `- Tokens: ${summary.usage.inputTokens} in (${summary.usage.cachedTokens} cached), ${summary.usage.outputTokens} out, ${summary.usage.reasoningTokens} reasoning`,
    `- Duration per PR: median ${summary.durationSeconds.median.toFixed(0)} s, p90 ${summary.durationSeconds.p90.toFixed(0)} s`,
    "",
    "## By language",
    "",
    "| Language | Precision | Recall | F1 | Generated | Expected |",
    "|---|---|---|---|---|---|",
    ...Object.entries(summary.byLanguage).map(
      ([language, s]) =>
        `| ${language} | ${pct(s.metrics.precision)} | ${pct(s.metrics.recall)} | ${pct(s.metrics.f1)} | ${s.counts.generated} | ${s.counts.expected} |`,
    ),
    "",
    "## Recall by issue category",
    "",
    ...recallTable(summary.recallByCategory),
    "",
    "## Recall by context level",
    "",
    ...recallTable(summary.recallByContext),
    "",
  ];
  return lines.join("\n");
}

function recallTable(groups: Summary["recallByCategory"]): string[] {
  return [
    "| Group | Recall | Matched | Expected |",
    "|---|---|---|---|",
    ...Object.entries(groups).map(
      ([name, g]) => `| ${name} | ${pct(g.recall)} | ${g.matched} | ${g.expected} |`,
    ),
  ];
}
