import type { Finding, PriorFinding, ReviewReport, Severity } from "@open-cr-agent/core";
import type { ReviewComment } from "./client.js";
import { SUMMARY_MARKER, writeState } from "./state.js";

const MAX_SUMMARY_CHARS = 60_000;
const ICON: Record<Severity, string> = { critical: "🔴", warning: "🟠", suggestion: "🔵" };
const VERDICT: Record<ReviewReport["verdict"], string> = {
  approved: "✅ Approved",
  approved_with_comments: "💬 Approved with comments",
  minor_issues: "⚠️ Minor issues",
  significant_concerns: "🛑 Significant concerns",
};

// Model text is untrusted: it may not close our markup, mention people,
// or pull in images and links that render as something else.
export function safeMarkdown(text: string): string {
  return text
    .replaceAll("<!--", "&lt;!--")
    .replace(/<\/?[a-zA-Z][^>]*>/g, (tag) => tag.replaceAll("<", "&lt;"))
    .replace(/@(?=[A-Za-z0-9-])/g, "@​")
    .replace(/!\[/g, "!​[");
}

function location(f: Finding): string {
  if (!f.lineRange) return `\`${f.file}\``;
  const { start, end } = f.lineRange;
  return `\`${f.file}:${start === end ? start : `${start}-${end}`}\``;
}

export function inlineBody(f: Finding): string {
  const parts = [
    `${ICON[f.severity]} **${safeMarkdown(f.title)}** · ${f.severity} · ${f.reviewer}`,
    "",
    safeMarkdown(f.body),
  ];
  if (f.suggestion) parts.push("", `**Suggestion:** ${safeMarkdown(f.suggestion)}`);
  return parts.join("\n");
}

export function inlineComment(f: Finding): ReviewComment | undefined {
  if (!f.lineRange || !f.anchor.inDiff) return undefined;
  const comment: ReviewComment = {
    path: f.file,
    line: f.lineRange.end,
    side: "RIGHT",
    body: inlineBody(f),
  };
  if (f.lineRange.start !== f.lineRange.end) {
    comment.start_line = f.lineRange.start;
    comment.start_side = "RIGHT";
  }
  return comment;
}

export interface SummaryInput {
  report: ReviewReport;
  // Findings shown as inline comments (now or in an earlier review).
  commented: ReadonlySet<string>;
  state: readonly PriorFinding[];
}

export function renderSummary({ report, commented, state }: SummaryInput): string {
  const counts = (["critical", "warning", "suggestion"] as const)
    .map((s) => `${report.findings.filter((f) => f.severity === s).length} ${s}`)
    .join(", ");
  const lines = [
    SUMMARY_MARKER,
    `## ocra review · ${VERDICT[report.verdict]}`,
    "",
    safeMarkdown(report.summary),
    "",
    `**${report.findings.length} finding(s)** (${counts}) · risk tier \`${report.tier}\``,
  ];

  const inSummary = report.findings.filter((f) => !commented.has(f.fingerprint));
  if (inSummary.length > 0) {
    lines.push("", "### Findings outside the diff");
    for (const f of inSummary) {
      lines.push(
        `- ${ICON[f.severity]} ${location(f)} **${safeMarkdown(f.title)}**: ${safeMarkdown(f.body).replaceAll("\n", " ")}`,
      );
    }
  }
  const rereview = report.rereview;
  if (rereview && rereview.fixed.length > 0) {
    lines.push("", "### Fixed since the last review");
    for (const f of rereview.fixed) lines.push(`- ~~${safeMarkdown(f.title)}~~ \`${f.file}\``);
  }
  if (rereview && rereview.notRechecked.length > 0) {
    lines.push("", "### Not re-checked this time");
    for (const f of rereview.notRechecked) lines.push(`- ${safeMarkdown(f.title)} \`${f.file}\``);
  }

  const failed = report.coverage.filter((c) => c.status === "failed" || c.status === "unreviewed");
  const { costUsd, inputTokens, outputTokens } = report.usage;
  lines.push(
    "",
    "<details><summary>Coverage and cost</summary>",
    "",
    `${report.coverage.filter((c) => c.status === "reviewed").length} reviewed · ${failed.length} not reviewed · ${report.coverage.filter((c) => c.status === "excluded").length} excluded · ${inputTokens} in / ${outputTokens} out tokens · $${costUsd.toFixed(4)}`,
    ...failed.map((c) => `- not reviewed: \`${c.path}\``),
    "",
    "</details>",
  );

  const text = lines.join("\n");
  const footer = `\n\n${writeState(state)}`;
  const room = MAX_SUMMARY_CHARS - footer.length;
  return (text.length > room ? `${text.slice(0, room - 40)}\n\n…(truncated)` : text) + footer;
}
