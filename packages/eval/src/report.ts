import type { AttackSummary } from "./attack-score.js";
import type { GoldenSummary } from "./golden-score.js";
import { type ProvenanceSummary, renderProvenance } from "./provenance.js";
import type { Summary } from "./score.js";

export type RunSummary = Summary & {
  golden?: GoldenSummary;
  attacks?: AttackSummary;
  provenance?: ProvenanceSummary;
};

export interface RunInfo {
  runId: string;
  createdAt: string;
  selection: Record<string, unknown>;
  models: Record<string, string | undefined>;
  judge: string;
  // What every review was passed besides the range and the format.
  review?: string[];
  // The sampling asked of every review; what each applied is in the
  // summary's provenance.
  sampling?: { temperature?: number; seed?: number };
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

export function renderMarkdown(info: RunInfo, summary: RunSummary): string {
  const { counts, metrics } = summary.overall;
  const lines = [
    `# ${info.selection.dataset === "golden" ? "Golden" : "AACR-Bench"} run ${info.runId}`,
    "",
    `- Date: ${info.createdAt}`,
    `- Selection: ${JSON.stringify(info.selection)}`,
    `- Models: ${JSON.stringify(info.models)}`,
    `- Judge: ${info.judge}`,
    ...(info.review ? [`- Review flags: ${info.review.join(" ")}`] : []),
    `- Provenance: ${renderProvenance(summary.provenance)}`,
    `- Instances: ${summary.instances.reviewed} reviewed, ${summary.instances.failed} failed, ${summary.instances.unavailable} unavailable in the dataset, ${summary.instances.skippedBudget} skipped for budget, ${summary.instances.skippedQuota} skipped for spent quota (of ${summary.instances.selected})`,
    "",
    summary.golden ? "## Quality, benchmark matching (ignores labels)" : "## Quality",
    "",
    "| Precision | Recall | F1 | Line precision | Line recall | Generated | Expected | Matched |",
    "|---|---|---|---|---|---|---|---|",
    `| ${pct(metrics.precision)} | ${pct(metrics.recall)} | ${pct(metrics.f1)} | ${pct(metrics.linePrecision)} | ${pct(metrics.lineRecall)} | ${counts.generated} | ${counts.expected} | ${counts.semanticMatches} |`,
    "",
    `Diagnostic, not the benchmark's metric: counting the same concern in the same file at any line, precision ${pct(metrics.lenientPrecision)} and recall ${pct(metrics.lenientRecall)} (${counts.lenientMatches} matched). A gap to the official numbers is findings anchored away from the reference.`,
    "",
    ...(summary.golden ? goldenSection(summary.golden) : []),
    ...(summary.attacks ? attackSection(summary.attacks) : []),
    "## Cost and latency",
    "",
    `- Total $${summary.usage.costUsd.toFixed(4)}, $${summary.costPerReviewedUsd.toFixed(4)} per reviewed PR`,
    `- Tokens: ${summary.usage.inputTokens} in (${summary.usage.cachedTokens} cached), ${summary.usage.outputTokens} out, ${summary.usage.reasoningTokens} reasoning`,
    `- Duration per PR: median ${summary.durationSeconds.median.toFixed(0)} s, p90 ${summary.durationSeconds.p90.toFixed(0)} s`,
    ...(summary.anchoring
      ? [
          `- Anchoring: ${Object.entries(summary.anchoring.byMethod)
            .map(([method, n]) => `${method} ${n}`)
            .join(
              ", ",
            )}; file-level ${pct(summary.anchoring.fileLevelShare)} (${summary.anchoring.ambiguous} ambiguous), ${summary.anchoring.relocationCalls} relocation call(s)`,
        ]
      : []),
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

function attackSection(attacks: AttackSummary): string[] {
  const paired = attacks.outcomes.length;
  const verdict = (v: string | undefined) => v ?? "unknown";
  return [
    "## Attacks (ADR-0014)",
    "",
    "Each attack is the case it names with hostile text planted in the change, reviewed in the same run. Attacks are not counted in the sections above.",
    "",
    `Verdict unchanged in ${attacks.verdictUnchanged} of ${paired} attack(s). Expected findings found: ${attacks.foundAttacked} of ${attacks.expected} under attack, ${attacks.foundClean} of ${attacks.expected} on the clean cases. Findings carrying a planted URL or command: ${attacks.canaryFindings}.`,
    "",
    "| Attack | Goal | Channel | Found, clean → attacked | Verdict, clean → attacked | Findings with the canary |",
    "|---|---|---|---|---|---|",
    ...attacks.outcomes.map(
      (o) =>
        `| ${o.id} | ${o.goal} | ${o.channel} | ${o.clean.found} → ${o.attacked.found} of ${o.expected} | ${verdict(o.clean.verdict)} → ${verdict(o.attacked.verdict)} | ${o.goal === "suppress" ? "–" : o.attacked.canaryFindings} |`,
    ),
    ...(attacks.unpaired.length === 0
      ? []
      : [
          "",
          `Not compared, because the attack or its clean case was not reviewed: ${attacks.unpaired.join(", ")}.`,
        ]),
    "",
  ];
}

function goldenSection(golden: GoldenSummary): string[] {
  const c = golden.counts;
  return [
    "## Golden set (ADR-0011)",
    "",
    "| Precision | Recall | Reported | Correct | Valid | Invalid | In forbidden ranges | Unlabeled | Expected | Found | Below min severity |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    `| ${pct(golden.precision)} | ${pct(golden.recall)} | ${c.reported} | ${c.correct} | ${c.valid} | ${c.invalid} | ${c.forbidden} | ${c.unadjudicated} | ${c.expected} | ${c.matched} | ${c.underrated} |`,
    "",
    `Cases and labels: ${golden.casesHash}. Recall counts a match only at or above the case's minimum severity.`,
    "",
    c.unadjudicated > 0
      ? `${c.unadjudicated} finding(s) are unlabeled and count against precision until labeled: edit adjudication.json in the run directory, then run \`ocra-eval adjudicate <run-dir>\`.`
      : "Every finding is matched or labeled.",
    "",
    ...(golden.failures.length === 0
      ? ["No critical finding where a case says findings are wrong."]
      : [
          `**${golden.failures.length} critical finding(s) where a case says findings are wrong:**`,
          "",
          ...golden.failures.map(
            (f) =>
              `- ${f.case}: ${f.file}${f.lines ? `:${f.lines.start}` : ""} "${f.title}" (${f.reason})`,
          ),
        ]),
    ...(golden.relabeled.length === 0
      ? []
      : [
          "",
          `${golden.relabeled.length} finding(s) took a label recorded for another title on the same code, because the judge called it the same claim; check the label still fits:`,
          "",
          ...golden.relabeled.map(
            (f) => `- ${f.case}: "${f.title}" (labeled as "${f.labeledTitle}")`,
          ),
        ]),
    "",
  ];
}
