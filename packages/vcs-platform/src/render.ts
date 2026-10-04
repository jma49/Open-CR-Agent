import {
  coverageGaps,
  type Finding,
  type ReviewReport,
  type Severity,
  type Verification,
} from "@open-cr-agent/core";
import { safeMarkdown } from "./neutralize.js";
import { type ReviewState, SUMMARY_MARKER, writeState } from "./state.js";

// GitHub rejects comments over 65,536 characters; GitLab takes 1,000,000,
// but a summary that long is no use to anyone.
const MAX_SUMMARY_CHARS = 65_000;

// How the summary names things on a platform.
export interface PlatformText {
  // "pull request" or "merge request".
  changeRequest: string;
  // Who may override a blocking verdict or dismiss a finding, completing
  // "Someone with … other than the author": "write access", for example.
  authority: string;
}
const ICON: Record<Severity, string> = { critical: "🔴", warning: "🟠", suggestion: "🔵" };
const VERIFICATION: Record<Verification, string> = {
  confirmed: "verified",
  uncertain: "unverified (verifier unsure)",
  unchecked: "not verified",
};

// A run that reviewed nothing has no verdict to announce, and one that missed
// files or could not verify a critical finding says so next to its verdict.
function headline(report: ReviewReport): string {
  const { notReviewed, nothingReviewed } = coverageGaps(report);
  if (nothingReviewed) return "⏸️ Not reviewed";
  const incomplete = notReviewed > 0 || report.unverifiedCriticals > 0;
  const overridden =
    report.verdict === "significant_concerns" && report.changeRequest.override
      ? " · overridden"
      : "";
  return `${VERDICT[report.verdict]}${overridden}${incomplete ? " · incomplete" : ""}`;
}

// Who overrode a blocking verdict, or how someone entitled to can.
function overrideNote(report: ReviewReport, text: PlatformText): string[] {
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
    `Someone with ${text.authority} other than the author can let this commit pass by commenting \`/ocra override ${report.changeRequest.headSha} <reason>\`.`,
  ];
}

function spendLimitNote(report: ReviewReport): string {
  const limit = report.spendLimit;
  if (!limit) return "";
  return ` of a $${limit.usd} limit${limit.reached ? ", reached" : ""}`;
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
    safeMarkdown(f.body, { startsLine: true }),
  ];
  if (f.suggestion) parts.push("", `**Suggestion:** ${safeMarkdown(f.suggestion)}`);
  return parts.join("\n");
}

export interface SummaryInput {
  report: ReviewReport;
  // Findings shown as inline comments (now or in an earlier review).
  commented: ReadonlySet<string>;
  state: ReviewState;
  text: PlatformText;
  // Findings still reported whose thread was resolved without saying by whom.
  unattributed?: number;
}

export function renderSummary({
  report,
  commented,
  state,
  text,
  unattributed = 0,
}: SummaryInput): string {
  const counts = (["critical", "warning", "suggestion"] as const)
    .map((s) => `${report.findings.filter((f) => f.severity === s).length} ${s}`)
    .join(", ");
  const lines = [
    SUMMARY_MARKER,
    `## ocra review · ${headline(report)}`,
    "",
    safeMarkdown(report.summary, { startsLine: true }),
    ...overrideNote(report, text),
    "",
    `**${report.findings.length} finding(s)** (${counts}) · risk tier \`${report.tier}\``,
  ];
  if (report.scope?.mode === "incremental") {
    lines.push("", `Reviewed only what changed since ${codeSpan(report.scope.since.slice(0, 7))}.`);
  } else if (report.scope) {
    lines.push("", `Reviewed every file again: ${safeMarkdown(report.scope.reason)}.`);
  }
  // Only true while no confirmed critical blocks, and low-confidence
  // findings do not count at all.
  const unverified =
    report.verdict === "significant_concerns"
      ? 0
      : report.findings.filter(
          (f) => f.severity === "critical" && f.verification !== "confirmed" && !f.lowConfidence,
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
  const { notReviewed } = coverageGaps(report);
  if (notReviewed > 0) {
    const limit = report.spendLimit?.reached
      ? `; the spend limit of $${report.spendLimit.usd} was reached`
      : "";
    lines.push(
      "",
      `**Incomplete:** ${notReviewed} selected file(s) were not reviewed${limit}. They are listed under Coverage and cost, and the next review of this ${text.changeRequest} includes them.`,
    );
  }

  if (unattributed > 0) {
    lines.push(
      "",
      `${unattributed} resolved thread(s) of ocra's did not dismiss their finding: nothing says who resolved them, as when a push resolves outdated threads. To dismiss a finding, answer its thread with \`/ocra dismiss\` or "won't fix".`,
    );
  }

  const inSummary = report.findings.filter((f) => !commented.has(f.fingerprint));
  if (inSummary.length > 0) {
    lines.push("", "### Findings outside the diff");
    for (const f of inSummary) {
      lines.push(
        `- ${ICON[f.severity]} ${location(f)} **${safeMarkdown(f.title)}** _(${verification(f)}${f.lowConfidence ? ", low confidence" : ""})_: ${safeMarkdown(f.body.replaceAll("\n", " "))}`,
      );
    }
  }
  const fromRepository = report.remembered.filter((e) => e.source === "repository").length;
  const fromAccount = report.remembered.length - fromRepository;
  if (fromRepository > 0) {
    lines.push(
      "",
      `${fromRepository} finding(s) matched \`.ocra/memory.json\` and are not repeated.`,
    );
  }
  // The reviewer's own account memory can hide findings too; say so, so a
  // suppression nobody on the team chose is visible (ADR-0028).
  if (fromAccount > 0) {
    lines.push(
      "",
      `${fromAccount} finding(s) matched the reviewing account's ocra Cloud memory and are not repeated.`,
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
    `${report.coverage.filter((c) => c.status === "reviewed").length} reviewed · ${report.coverage.filter((c) => c.status === "unchanged").length} unchanged since the last review · ${failed.length} not reviewed · ${report.coverage.filter((c) => c.status === "excluded").length} excluded · ${inputTokens} in / ${outputTokens} out tokens · $${costUsd.toFixed(4)}${spendLimitNote(report)} · run ${codeSpan(report.runId)}`,
    ...failed.map((c) => `- not reviewed: ${codeSpan(c.path)}`),
    "",
    "</details>",
  );

  const markdown = lines.join("\n");
  const footer = `\n\n${writeState(state)}`;
  const room = MAX_SUMMARY_CHARS - footer.length;
  return (
    (markdown.length > room ? `${markdown.slice(0, room - 40)}\n\n…(truncated)` : markdown) + footer
  );
}
