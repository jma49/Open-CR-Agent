import {
  type CoverageEntry,
  coverageGaps,
  type Finding,
  type IncompleteEnding,
  isIncompleteReview,
  isUnfinished,
  type PriorFinding,
  type ReviewReport,
  type Severity,
  type Verification,
} from "@open-cr-agent/core";
import { byline } from "./byline.js";
import { incompleteNotes } from "./incomplete-notes.js";
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
const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  warning: "Warning",
  suggestion: "Suggestion",
};
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
    `Someone with ${text.authority} other than the author can let this commit pass by commenting \`@ocra override ${report.changeRequest.headSha} <reason>\`.`,
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

// Model text within one of ocra's lines (a title, a body in a list) stays on
// that line. A line break would continue a list item, which safeMarkdown's
// parse does not see, and a table delimiter row there would split the code
// spans it found on the line above.
export function safeLine(text: string): string {
  return safeMarkdown(text.replace(/\r\n?|\n/g, " "));
}

function location(f: Finding): string {
  if (!f.lineRange) return codeSpan(f.file);
  const { start, end } = f.lineRange;
  return codeSpan(`${f.file}:${start === end ? start : `${start}-${end}`}`);
}

const TILDE_FENCE = /^ {0,3}~{3,}/m;

export const FINDING_MARKER = /<!-- ocra:finding ([0-9a-f]{16}) -->/;

const MAX_EVIDENCE_ITEMS = 5;
const MAX_EVIDENCE_CHARS = 300;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// What a finding is and how far to trust it, least surprising first.
function notes(f: Finding): string {
  return [
    SEVERITY_LABEL[f.severity],
    f.reviewer,
    verification(f),
    ...(f.lowConfidence ? ["low confidence"] : []),
    ...(f.preExisting ? ["pre-existing"] : []),
  ].join(" · ");
}

// Folded: the facts behind a finding are for whoever doubts it.
function evidenceSection(evidence: readonly string[]): string[] {
  const facts = evidence.filter((e) => e.trim() !== "").slice(0, MAX_EVIDENCE_ITEMS);
  if (facts.length === 0) return [];
  return [
    "",
    "<details><summary>Evidence</summary>",
    "",
    ...facts.map((e) => `- ${safeLine(clip(e, MAX_EVIDENCE_CHARS))}`),
    "",
    "</details>",
  ];
}

// The title stands alone on the first line, the notes under it in the same
// paragraph: a backslash breaks the line on GitHub and on GitLab alike.
export function inlineBody(f: Finding, fence: SuggestionFence, agent?: string): string {
  const parts = [
    `<!-- ocra:finding ${f.fingerprint} -->`,
    `${ICON[f.severity]} **${safeLine(f.title)}**\\`,
    notes(f),
    "",
    safeMarkdown(f.body, { startsLine: true }),
  ];
  if (f.suggestion) parts.push("", `**Suggested fix:** ${safeMarkdown(f.suggestion)}`);
  // A `~~~` fence in model text keeps its fence through safeMarkdown, and one
  // left open would run to the end of the comment and swallow ocra's
  // suggestion block, so the fence is why the block is left out.
  const block = TILDE_FENCE.test(parts.join("\n")) ? undefined : suggestionBlock(f, fence);
  if (block) parts.push("", block);
  parts.push(...evidenceSection(f.evidence));
  if (agent) parts.push("", `<sub>${byline(agent)}</sub>`);
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
    ...walkthroughSection(report.walkthrough),
    ...mergeChecksSection(report.mergeChecks),
    ...incompleteNotes(report, text),
    ...unattributedNote(unattributed),
    ...outsideDiff(report, commented),
    ...heldInline(report, commented),
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

// The heading, the judge's summary and one line of counts: what the review
// found is said once, and the findings themselves are on the diff.
function verdictSection(report: ReviewReport, text: PlatformText): string[] {
  const summary = report.summary.trim();
  return [
    SUMMARY_MARKER,
    `## ${byline(report.agent)} review · ${headline(report)}`,
    ...(summary === "" ? [] : ["", safeMarkdown(summary, { startsLine: true })]),
    ...overrideNote(report, text),
    "",
    countsLine(report),
  ];
}

function countsLine(report: ReviewReport): string {
  const counts = (["critical", "warning", "suggestion"] as const).flatMap((severity) => {
    const n = report.findings.filter((f) => f.severity === severity).length;
    return n === 0 ? [] : [`${n} ${severity}${n === 1 ? "" : "s"}`];
  });
  const tier = `risk tier \`${report.tier}\``;
  return counts.length === 0
    ? `Risk tier \`${report.tier}\``
    : `**${counts.join(", ")}** · ${tier}`;
}

const MAX_LISTED_FILES = 10;

// The overview is read first; the file groups and the diagram are there for
// whoever wants them before the diff, so they are folded.
function walkthroughSection(walkthrough: ReviewReport["walkthrough"]): string[] {
  if (!walkthrough) return [];
  const files = walkthrough.groups.reduce((n, g) => n + g.files.length, 0);
  const lines = [
    "",
    "### Walkthrough",
    "",
    safeMarkdown(walkthrough.overview, { startsLine: true }),
    "",
    `<details><summary>Changes in ${files} file(s)</summary>`,
    "",
    ...walkthrough.groups.map(walkthroughGroup),
    "",
    "</details>",
  ];
  if (walkthrough.diagram) {
    lines.push(
      "",
      "<details><summary>Sequence diagram</summary>",
      "",
      "```mermaid",
      walkthrough.diagram,
      "```",
      "",
      "</details>",
    );
  }
  return lines;
}

function walkthroughGroup(group: { title: string; files: string[]; note: string }): string {
  const shown = group.files.slice(0, MAX_LISTED_FILES).map(codeSpan).join(" · ");
  const more = group.files.length - MAX_LISTED_FILES;
  const files = more > 0 ? `${shown} and ${more} more` : shown;
  const note = group.note === "" ? "" : `: ${safeLine(group.note)}`;
  return `- **${safeLine(group.title)}**${note}\n  ${files}`;
}

const OUTCOME_LABEL = { passed: "Passed", failed: "Failed", inconclusive: "Inconclusive" } as const;

function mergeChecksSection(results: ReviewReport["mergeChecks"]): string[] {
  if (!results?.length) return [];
  return [
    "",
    "### Pre-merge checks",
    "",
    ...results.map(
      (r) =>
        `- **${OUTCOME_LABEL[r.outcome]}**: ${safeLine(r.instruction)}${r.reason === "" ? "" : `\n  ${safeLine(r.reason)}`}`,
    ),
  ];
}

function scopeNote(report: ReviewReport): string[] {
  if (report.scope?.mode === "incremental") {
    return ["", `Reviewed only what changed since ${codeSpan(report.scope.since.slice(0, 7))}.`];
  }
  if (report.scope) return ["", `Reviewed every file again: ${safeMarkdown(report.scope.reason)}.`];
  return [];
}

function unattributedNote(unattributed: number): string[] {
  if (unattributed <= 0) return [];
  return [
    "",
    `${unattributed} resolved thread(s) of ocra's did not dismiss their finding: nothing says who resolved them, as when a push resolves outdated threads. To dismiss a finding, answer its thread with \`@ocra dismiss\` or "won't fix".`,
  ];
}

function summaryLine(f: Finding): string {
  return `- ${ICON[f.severity]} **${safeLine(f.title)}** · ${location(f)} · ${verification(f)}${f.lowConfidence ? " · low confidence" : ""}${f.preExisting ? " · pre-existing" : ""}\\\n  ${safeLine(f.body)}`;
}

function heldFingerprints(report: ReviewReport): Set<string> {
  return new Set(report.inline?.held.map((h) => h.fingerprint));
}

function outsideDiff(report: ReviewReport, commented: ReadonlySet<string>): string[] {
  const held = heldFingerprints(report);
  const inSummary = report.findings.filter(
    (f) => !commented.has(f.fingerprint) && !held.has(f.fingerprint),
  );
  if (inSummary.length === 0) return [];
  return ["", "### Findings outside the diff", ...inSummary.map(summaryLine)];
}

// The findings the inline policy held back (ADR-0076), folded: whoever chose
// fewer comments still finds every finding here, in the policy's order.
function heldInline(report: ReviewReport, commented: ReadonlySet<string>): string[] {
  const inline = report.inline;
  if (!inline) return [];
  const byFingerprint = new Map(report.findings.map((f) => [f.fingerprint, f]));
  const shown = inline.held.flatMap((h) => {
    const f = byFingerprint.get(h.fingerprint);
    return f && !commented.has(f.fingerprint) ? [{ f, reason: h.reason }] : [];
  });
  if (shown.length === 0) return [];
  const below = shown.filter((s) => s.reason === "below_floor").length;
  const over = shown.length - below;
  const why = [
    ...(below > 0 ? [`${below} below the ${inline.minSeverity} severity floor`] : []),
    ...(over > 0 ? [`${over} past the limit of ${inline.maxComments} inline comment(s)`] : []),
  ].join(", ");
  return [
    "",
    `<details><summary>${shown.length} finding(s) not posted inline: ${why}</summary>`,
    "",
    ...shown.map((s) => summaryLine(s.f)),
    "",
    "</details>",
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
  context_window: "partly reviewed (context window full)",
  stopped_early: "partly reviewed (stopped early)",
};

function unfinishedLabel(entry: CoverageEntry): string {
  return entry.status === "incomplete" ? PARTLY[entry.ended] : "not reviewed";
}
