import {
  coverageGaps,
  type Finding,
  type PriorFinding,
  type ReviewReport,
  type Severity,
  type Verification,
} from "@open-cr-agent/core";
import type { ReviewComment } from "./client.js";
import { type ReviewState, SUMMARY_MARKER, writeState } from "./state.js";

// GitHub rejects comments over 65,536 characters.
const MAX_SUMMARY_CHARS = 65_000;
const ICON: Record<Severity, string> = { critical: "🔴", warning: "🟠", suggestion: "🔵" };
const VERIFICATION: Record<Verification, string> = {
  confirmed: "verified",
  uncertain: "unverified (verifier unsure)",
  unchecked: "not verified",
};

// A run that reviewed nothing has no verdict to announce, and one that missed
// files or could not verify a critical finding says so next to its verdict.
function headline(report: ReviewReport): string {
  const { notReviewed, nothingReviewed } = coverageGaps(report.coverage);
  if (nothingReviewed) return "⏸️ Not reviewed";
  const incomplete = notReviewed > 0 || report.unverifiedCriticals > 0;
  const overridden =
    report.verdict === "significant_concerns" && report.changeRequest.override
      ? " · overridden"
      : "";
  return `${VERDICT[report.verdict]}${overridden}${incomplete ? " · incomplete" : ""}`;
}

// Who overrode a blocking verdict, or how someone entitled to can.
function overrideNote(report: ReviewReport): string[] {
  if (report.verdict !== "significant_concerns") return [];
  const override = report.changeRequest.override;
  if (override) {
    return [
      "",
      `**Overridden** by @\u200b${safeMarkdown(override.by)} for ${codeSpan(report.changeRequest.headSha.slice(0, 7))}: ${safeMarkdown(override.reason)}`,
    ];
  }
  return [
    "",
    `Someone with write access other than the author can let this commit pass by commenting \`/ocra override ${report.changeRequest.headSha.slice(0, 7)} <reason>\`.`,
  ];
}

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
// (a bot comment lends it credibility). Inline links lose their `](`, and
// reference definitions (`[1]: https://…`) their line-start form, which is
// what every reference-style link (`[x][1]`, `[x][]`, `[1]`) needs. Bare URLs
// still show as text.
export function safeMarkdown(text: string): string {
  return text
    .replaceAll("<!--", "&lt;!--")
    .replace(/<\/?[a-zA-Z][^>]*>/g, (tag) => tag.replaceAll("<", "&lt;"))
    .replace(/@(?=[A-Za-z0-9-])/g, "@\u200b")
    .replace(/!\[/g, "!\u200b[")
    .replaceAll("](", "]\\(")
    .replace(/^([ \t]{0,3})\[([^\]\n]*)\]:/gm, "$1\\[$2]:");
}

// File paths come from the diff, so the author controls them: a backtick or
// newline must not end the code span and let markup through, and angle
// brackets must not form ocra's HTML-comment markers in the raw body.
export function codeSpan(text: string): string {
  const safe = text
    .replaceAll("`", "\u02cb")
    .replace(/[\r\n]+/g, " ")
    .replaceAll("<", "\u2039")
    .replaceAll(">", "\u203a");
  return `\`${safe}\``;
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
  state: ReviewState;
}

export function renderSummary({ report, commented, state }: SummaryInput): string {
  const counts = (["critical", "warning", "suggestion"] as const)
    .map((s) => `${report.findings.filter((f) => f.severity === s).length} ${s}`)
    .join(", ");
  const lines = [
    SUMMARY_MARKER,
    `## ocra review · ${headline(report)}`,
    "",
    safeMarkdown(report.summary),
    ...overrideNote(report),
    "",
    `**${report.findings.length} finding(s)** (${counts}) · risk tier \`${report.tier}\``,
  ];
  if (report.scope?.mode === "incremental") {
    lines.push("", `Reviewed only what changed since ${codeSpan(report.scope.since.slice(0, 7))}.`);
  } else if (report.scope) {
    lines.push("", `Reviewed every file again: ${safeMarkdown(report.scope.reason)}.`);
  }
  const unverified = report.findings.filter(
    (f) => f.severity === "critical" && f.verification !== "confirmed",
  ).length;
  if (unverified > 0) {
    lines.push(
      "",
      `${unverified} critical finding(s) are not verified, so they cap the verdict at minor issues.`,
    );
  }
  if (report.unverifiedCriticals > 0) {
    lines.push(
      "",
      `**Incomplete:** verification failed or ran out of budget for ${report.unverifiedCriticals} critical finding(s); check them yourself.`,
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
  if (rereview && rereview.unchanged.length > 0) {
    lines.push(
      "",
      "### Still open in unchanged files",
      "",
      "Reported earlier in files not changed since; they count in the verdict.",
      "",
    );
    for (const f of rereview.unchanged)
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
    `${report.coverage.filter((c) => c.status === "reviewed").length} reviewed · ${report.coverage.filter((c) => c.status === "unchanged").length} unchanged since the last review · ${failed.length} not reviewed · ${report.coverage.filter((c) => c.status === "excluded").length} excluded · ${inputTokens} in / ${outputTokens} out tokens · $${costUsd.toFixed(4)}`,
    ...failed.map((c) => `- not reviewed: ${codeSpan(c.path)}`),
    "",
    "</details>",
  );

  const text = lines.join("\n");
  const footer = `\n\n${writeState(state)}`;
  const room = MAX_SUMMARY_CHARS - footer.length;
  return (text.length > room ? `${text.slice(0, room - 40)}\n\n…(truncated)` : text) + footer;
}
