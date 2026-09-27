import type {
  Finding,
  PriorFinding,
  ReviewReport,
  Severity,
  Verification,
} from "@open-cr-agent/core";
import type { ReviewComment } from "./client.js";
import { SUMMARY_MARKER, writeState } from "./state.js";

const MAX_SUMMARY_CHARS = 60_000;
const ICON: Record<Severity, string> = { critical: "🔴", warning: "🟠", suggestion: "🔵" };
const VERIFICATION: Record<Verification, string> = {
  confirmed: "verified",
  uncertain: "unverified (verifier unsure)",
  unchecked: "not verified",
};

function verification(f: { verification?: Verification }): string {
  return VERIFICATION[f.verification ?? "unchecked"];
}

const VERDICT: Record<ReviewReport["verdict"], string> = {
  approved: "✅ Approved",
  approved_with_comments: "💬 Approved with comments",
  minor_issues: "⚠️ Minor issues",
  significant_concerns: "🛑 Significant concerns",
};

// Model text is untrusted: it may not close our markup, mention people,
// pull in images, or render as a link that says one thing and goes elsewhere
// (a bot comment lends it credibility). Bare URLs still show as text.
export function safeMarkdown(text: string): string {
  return text
    .replaceAll("<!--", "&lt;!--")
    .replace(/<\/?[a-zA-Z][^>]*>/g, (tag) => tag.replaceAll("<", "&lt;"))
    .replace(/@(?=[A-Za-z0-9-])/g, "@\u200b")
    .replace(/!\[/g, "!\u200b[")
    .replaceAll("](", "]\\(");
}

// File paths come from the diff, so the author controls them: a backtick or
// newline must not end the code span and let markup through.
export function codeSpan(text: string): string {
  return `\`${text.replaceAll("`", "\u02cb").replace(/[\r\n]+/g, " ")}\``;
}

function location(f: Finding): string {
  if (!f.lineRange) return codeSpan(f.file);
  const { start, end } = f.lineRange;
  return codeSpan(`${f.file}:${start === end ? start : `${start}-${end}`}`);
}

export const FINDING_MARKER = /<!-- ocra:finding ([0-9a-f]{16}) -->/;

export function inlineBody(f: Finding): string {
  const parts = [
    `<!-- ocra:finding ${f.fingerprint} -->`,
    `${ICON[f.severity]} **${safeMarkdown(f.title)}** · ${f.severity} · ${verification(f)} · ${f.reviewer}${f.lowConfidence ? " · low confidence" : ""}`,
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
  const unverified = report.findings.filter(
    (f) => f.severity === "critical" && f.verification !== "confirmed",
  ).length;
  if (unverified > 0) {
    lines.push(
      "",
      `${unverified} critical finding(s) are not verified, so they cap the verdict at minor issues.`,
    );
  }

  const inSummary = report.findings.filter((f) => !commented.has(f.fingerprint));
  if (inSummary.length > 0) {
    lines.push("", "### Findings outside the diff");
    for (const f of inSummary) {
      lines.push(
        `- ${ICON[f.severity]} ${location(f)} **${safeMarkdown(f.title)}** _(${verification(f)}${f.lowConfidence ? ", low confidence" : ""})_: ${safeMarkdown(f.body).replaceAll("\n", " ")}`,
      );
    }
  }
  if (report.remembered.length > 0) {
    lines.push(
      "",
      `${report.remembered.length} finding(s) matched \`.ocra/memory.json\` and are not repeated.`,
    );
  }
  const rereview = report.rereview;
  if (rereview && rereview.fixed.length > 0) {
    lines.push("", "### Fixed since the last review");
    for (const f of rereview.fixed)
      lines.push(`- ~~${safeMarkdown(f.title)}~~ ${codeSpan(f.file)}`);
  }
  if (rereview && rereview.notReproduced.length > 0) {
    lines.push(
      "",
      "### Not reported this time, code unchanged",
      "",
      "Still open and counted in the verdict until the code changes or a reviewer dismisses them.",
      "",
    );
    for (const f of rereview.notReproduced)
      lines.push(
        `- ${ICON[f.severity]} ${safeMarkdown(f.title)} ${codeSpan(f.file)} _(${verification(f)})_`,
      );
  }
  if (rereview && rereview.dismissed.length > 0) {
    lines.push("", "### Dismissed by reviewers");
    for (const f of rereview.dismissed)
      lines.push(`- ${safeMarkdown(f.title)} ${codeSpan(f.file)}`);
  }
  if (rereview && rereview.notRechecked.length > 0) {
    lines.push(
      "",
      "### Not re-checked this time",
      "",
      "Their files were not reviewed in this run; they stay open and count in the verdict.",
      "",
    );
    for (const f of rereview.notRechecked)
      lines.push(
        `- ${ICON[f.severity]} ${safeMarkdown(f.title)} ${codeSpan(f.file)} _(${verification(f)})_`,
      );
  }

  const failed = report.coverage.filter((c) => c.status === "failed" || c.status === "unreviewed");
  const { costUsd, inputTokens, outputTokens } = report.usage;
  lines.push(
    "",
    "_The verdict is advice from language models that read the change itself, and can be swayed by text in it. Do not use it as a security gate._",
    "",
    "<details><summary>Coverage and cost</summary>",
    "",
    `${report.coverage.filter((c) => c.status === "reviewed").length} reviewed · ${failed.length} not reviewed · ${report.coverage.filter((c) => c.status === "excluded").length} excluded · ${inputTokens} in / ${outputTokens} out tokens · $${costUsd.toFixed(4)}`,
    ...failed.map((c) => `- not reviewed: ${codeSpan(c.path)}`),
    "",
    "</details>",
  );

  const text = lines.join("\n");
  const footer = `\n\n${writeState(state)}`;
  const room = MAX_SUMMARY_CHARS - footer.length;
  return (text.length > room ? `${text.slice(0, room - 40)}\n\n…(truncated)` : text) + footer;
}
