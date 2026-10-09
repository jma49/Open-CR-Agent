import {
  type CoverageEntry,
  coverageGaps,
  type Finding,
  type IncompleteEnding,
  isIncompleteReview,
  isUnfinished,
  MAX_AGENT_STEPS,
  type PriorFinding,
  type ReviewReport,
  type Severity,
  type Verification,
} from "@open-cr-agent/core";
import { unconfirmedCriticals } from "@open-cr-agent/core/internal";
import { safeMarkdown } from "./neutralize.js";
import { type ReviewState, SUMMARY_MARKER, writeState } from "./state.js";
import { type SuggestionFence, suggestionBlock } from "./suggestion.js";

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
  if (coverageGaps(report).nothingReviewed) return "⏸️ Not reviewed";
  const overridden =
    report.verdict === "significant_concerns" && report.changeRequest.override
      ? " · overridden"
      : "";
  return `${VERDICT[report.verdict]}${overridden}${isIncompleteReview(report) ? " · incomplete" : ""}`;
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
function codeSpan(text: string): string {
  const safe = text
    .replaceAll("`", "\u02cb")
    .replace(/[\r\n]+/g, " ")
    .replaceAll("<", "\u2039")
    .replaceAll(">", "\u203a");
  return `\`${safe}\``;
}

// Model text within one of ocra's lines (a title, a body in a list) stays on
// that line. A line break would continue a list item, which safeMarkdown's
// parse does not see, and a table delimiter row there would split the code
// spans it found on the line above.
function safeLine(text: string): string {
  return safeMarkdown(text.replace(/\r\n?|\n/g, " "));
}

function location(f: Finding): string {
  if (!f.lineRange) return codeSpan(f.file);
  const { start, end } = f.lineRange;
  return codeSpan(`${f.file}:${start === end ? start : `${start}-${end}`}`);
}

const TILDE_FENCE = /^ {0,3}~{3,}/m;

export const FINDING_MARKER = /<!-- ocra:finding ([0-9a-f]{16}) -->/;

export function inlineBody(f: Finding, fence: SuggestionFence): string {
  const parts = [
    `<!-- ocra:finding ${f.fingerprint} -->`,
    `${ICON[f.severity]} **${safeLine(f.title)}** · ${f.severity} · ${verification(f)} · ${f.reviewer}${f.lowConfidence ? " · low confidence" : ""}`,
    "",
    safeMarkdown(f.body, { startsLine: true }),
  ];
  if (f.suggestion) parts.push("", `**Suggestion:** ${safeMarkdown(f.suggestion)}`);
  // A `~~~` fence in model text keeps its fence through safeMarkdown, and one
  // left open would run to the end of the comment and swallow ocra's
  // suggestion block, so the fence is why the block is left out.
  const block = TILDE_FENCE.test(parts.join("\n")) ? undefined : suggestionBlock(f, fence);
  if (block) parts.push("", block);
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
  const lines = [
    ...verdictSection(report, text),
    ...scopeNote(report),
    ...incompleteNotes(report, text),
    ...unattributedNote(unattributed),
    ...outsideDiff(report.findings, commented),
    ...memoryNotes(report.remembered),
    ...rereviewSections(report.rereview),
    ...coverageAndCost(report),
  ];
  const markdown = lines.join("\n");
  const footer = `\n\n${writeState(state)}`;
  const room = MAX_SUMMARY_CHARS - footer.length;
  return (
    (markdown.length > room ? `${markdown.slice(0, room - 40)}\n\n…(truncated)` : markdown) + footer
  );
}

function verdictSection(report: ReviewReport, text: PlatformText): string[] {
  const counts = (["critical", "warning", "suggestion"] as const)
    .map((s) => `${report.findings.filter((f) => f.severity === s).length} ${s}`)
    .join(", ");
  return [
    SUMMARY_MARKER,
    `## ocra review · ${headline(report)}`,
    "",
    safeMarkdown(report.summary, { startsLine: true }),
    ...overrideNote(report, text),
    "",
    `**${report.findings.length} finding(s)** (${counts}) · risk tier \`${report.tier}\``,
  ];
}

function scopeNote(report: ReviewReport): string[] {
  if (report.scope?.mode === "incremental") {
    return ["", `Reviewed only what changed since ${codeSpan(report.scope.since.slice(0, 7))}.`];
  }
  if (report.scope) return ["", `Reviewed every file again: ${safeMarkdown(report.scope.reason)}.`];
  return [];
}

// Unverified criticals that cap the verdict, and what the run did not check.
function incompleteNotes(report: ReviewReport, text: PlatformText): string[] {
  const lines: string[] = [];
  const unverified = unconfirmedCriticals(report);
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
  // The CLI's partly-reviewed.ts says the same for a terminal; this one names
  // the platform and points at the next review.
  const { notReviewed, incomplete } = coverageGaps(report);
  const gaps: string[] = [];
  const missed = notReviewed - incomplete.step_cap - incomplete.stopped_early;
  if (missed > 0) {
    const limit = report.spendLimit?.reached
      ? `; the spend limit of $${report.spendLimit.usd} was reached`
      : "";
    gaps.push(`**Incomplete:** ${missed} selected file(s) were not reviewed${limit}.`);
  }
  if (incomplete.step_cap > 0) {
    gaps.push(
      `**Incomplete:** ${incomplete.step_cap} selected file(s) were only partly reviewed: a reviewer used all ${MAX_AGENT_STEPS} of its steps before it finished them. The step limit is fixed; a smaller ${text.changeRequest} gives each file more of them.`,
    );
  }
  if (incomplete.stopped_early > 0) {
    gaps.push(
      `**Incomplete:** ${incomplete.stopped_early} selected file(s) were only partly reviewed: a reviewer stopped with steps left, without saying it had finished them. Run the review again, or use a stronger model if it keeps stopping.`,
    );
  }
  const last = gaps.pop();
  if (last !== undefined) {
    for (const gap of gaps) lines.push("", gap);
    lines.push(
      "",
      `${last} They are listed under Coverage and cost, and the next review of this ${text.changeRequest} includes them.`,
    );
  }
  return lines;
}

function unattributedNote(unattributed: number): string[] {
  if (unattributed <= 0) return [];
  return [
    "",
    `${unattributed} resolved thread(s) of ocra's did not dismiss their finding: nothing says who resolved them, as when a push resolves outdated threads. To dismiss a finding, answer its thread with \`/ocra dismiss\` or "won't fix".`,
  ];
}

function outsideDiff(findings: readonly Finding[], commented: ReadonlySet<string>): string[] {
  const inSummary = findings.filter((f) => !commented.has(f.fingerprint));
  if (inSummary.length === 0) return [];
  return [
    "",
    "### Findings outside the diff",
    ...inSummary.map(
      (f) =>
        `- ${ICON[f.severity]} ${location(f)} **${safeLine(f.title)}** _(${verification(f)}${f.lowConfidence ? ", low confidence" : ""})_: ${safeLine(f.body)}`,
    ),
  ];
}

function memoryNotes(remembered: ReviewReport["remembered"]): string[] {
  const lines: string[] = [];
  // Entries without a source (older reports, other adapters) are not
  // attributed to either memory.
  const fromRepository = remembered.filter((e) => e.source === "repository").length;
  const fromAccount = remembered.filter((e) => e.source === "account").length;
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
  return lines;
}

function rereviewSections(rereview: ReviewReport["rereview"]): string[] {
  if (!rereview) return [];
  return [
    ...(rereview.fixed.length > 0
      ? [
          "",
          "### Fixed since the last review",
          ...rereview.fixed.map((f) => `- ~~${safeLine(f.title)}~~ ${codeSpan(f.file)}`),
        ]
      : []),
    ...openList(
      "Not reported this time, code unchanged",
      "Still open and counted in the verdict until the code changes or a maintainer dismisses them.",
      rereview.notReproduced,
    ),
    ...openList(
      "Still open in unchanged files",
      "Reported earlier in files not changed since; they count in the verdict.",
      rereview.unchanged,
    ),
    ...(rereview.dismissed.length > 0
      ? [
          "",
          "### Dismissed by maintainers",
          ...rereview.dismissed.map((f) => `- ${safeLine(f.title)} ${codeSpan(f.file)}`),
        ]
      : []),
    ...openList(
      "Not re-checked this time",
      "Their files were not reviewed in this run; they stay open and count in the verdict.",
      rereview.notRechecked,
    ),
  ];
}

// Earlier findings still open, under a heading that says why.
function openList(title: string, intro: string, findings: readonly PriorFinding[]): string[] {
  if (findings.length === 0) return [];
  return [
    "",
    `### ${title}`,
    "",
    intro,
    "",
    ...findings.map(
      (f) =>
        `- ${ICON[f.severity]} ${safeLine(f.title)} ${codeSpan(f.file)} _(${verification(f)})_`,
    ),
  ];
}

function coverageAndCost(report: ReviewReport): string[] {
  const unfinished = report.coverage.filter(isUnfinished);
  const count = (status: string) => report.coverage.filter((c) => c.status === status).length;
  const partly = count("incomplete");
  const { costUsd, inputTokens, outputTokens } = report.usage;
  return [
    "",
    "_The verdict is advice from language models that read the change itself, and can be swayed by text in it. Do not use it as a security gate._",
    "",
    "<details><summary>Coverage and cost</summary>",
    "",
    `${count("reviewed")} reviewed${partly > 0 ? ` · ${partly} partly reviewed` : ""} · ${count("unchanged")} unchanged since the last review · ${unfinished.length - partly} not reviewed · ${count("excluded")} excluded · ${inputTokens} in / ${outputTokens} out tokens · $${costUsd.toFixed(4)}${spendLimitNote(report)} · run ${codeSpan(report.runId)}`,
    ...unfinished.map((c) => `- ${unfinishedLabel(c)}: ${codeSpan(c.path)}`),
    "",
    "</details>",
  ];
}

const PARTLY: Record<IncompleteEnding, string> = {
  step_cap: "partly reviewed (out of steps)",
  stopped_early: "partly reviewed (stopped early)",
};

function unfinishedLabel(entry: CoverageEntry): string {
  return entry.status === "incomplete" ? PARTLY[entry.ended] : "not reviewed";
}
