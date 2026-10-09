import {
  coverageGaps,
  type Finding,
  type ReviewReport,
  type Severity,
  toReportOutput,
  type Verification,
} from "@open-cr-agent/core";
import { serializeOutput } from "@open-cr-agent/core/internal";
import { forTerminal } from "../../io/terminal.js";
import { partlyReviewed, partlyReviewedCount } from "./partly-reviewed.js";

const SEVERITIES: Severity[] = ["critical", "warning", "suggestion"];
const VERIFICATION: Record<Verification, string> = {
  confirmed: "verified",
  uncertain: "unverified",
  unchecked: "not verified",
};

// JSON.stringify escapes C0 controls but not C1 controls or bidirectional
// overrides, which a terminal or an editor would act on.
export function renderJson(report: ReviewReport): string {
  return `${safeJson(toReportOutput(report))}\n`;
}

export const safeJson = serializeOutput;

export function renderText(report: ReviewReport, sessionDir?: string): string {
  const incomplete = report.tasks.filter((t) => t.status !== "completed");
  const { notReviewed, nothingReviewed, incomplete: partly } = coverageGaps(report);
  const lines: string[] = [
    `Review: ${report.changeRequest.title}`,
    coverageLine(report),
    ...(nothingReviewed
      ? ["Verdict: not reached (nothing was reviewed)"]
      : [`Verdict: ${report.verdict.replaceAll("_", " ")}`, ...indented(report.summary, "  ")]),
    "",
  ];

  if (report.findings.length === 0) {
    lines.push(emptyMessage(report, nothingReviewed, notReviewed), "");
  } else {
    for (const [file, findings] of groupByFile(report.findings)) {
      lines.push(file);
      for (const finding of findings) lines.push(...renderFinding(finding));
      lines.push("");
    }
  }

  lines.push(summaryLine(report));
  const override = report.changeRequest.override;
  if (override && report.verdict === "significant_concerns") {
    lines.push(`Overridden by ${override.by}: ${override.reason}`);
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
      `${unverified} critical finding(s) are not verified, so the verdict is at most minor issues.`,
    );
  }
  if (report.unverifiedCriticals > 0) {
    lines.push(
      `Incomplete: verification failed or ran out of budget for ${report.unverifiedCriticals} critical finding(s); check them yourself.`,
    );
  }
  const { refuted } = report;
  if (refuted.length > 0) {
    lines.push(
      `Verification dropped ${refuted.length} finding(s) the code disproves (see the JSON report).`,
    );
  }
  // Entries without a source (older reports, other adapters) are not
  // attributed to either memory.
  const fromRepository = report.remembered.filter((e) => e.source === "repository").length;
  const fromAccount = report.remembered.filter((e) => e.source === "account").length;
  if (fromRepository > 0) {
    lines.push(
      `${fromRepository} finding(s) matched the repository's memory and were not reported.`,
    );
  }
  if (fromAccount > 0) {
    lines.push(`${fromAccount} finding(s) matched your ocra Cloud memory and were not reported.`);
  }
  const rereview = report.rereview;
  if (report.scope?.mode === "incremental") {
    lines.push(`Reviewed only what changed since ${report.scope.since.slice(0, 7)}.`);
  } else if (report.scope) {
    lines.push(`Reviewed every file again: ${report.scope.reason}.`);
  }
  if (rereview) {
    lines.push(
      `Since the last review: ${rereview.fixed.length} fixed, ${rereview.dismissed.length} dismissed by reviewers, ${rereview.notReproduced.length} not reported again but unchanged, ${rereview.notRechecked.length} not re-checked, ${rereview.unchanged.length} in unchanged files (still open ones count in the verdict).`,
    );
  }
  const ambiguous = report.anchoring?.ambiguous ?? 0;
  if (ambiguous > 0) {
    lines.push(
      `${ambiguous} finding(s) quote code that appears in several places; shown without a line.`,
    );
  }
  const judged = report.judgement;
  if (judged && judged.merged.length + judged.dropped.length > 0) {
    lines.push(
      `Judge merged ${judged.merged.length} duplicate group(s) and dropped ${judged.dropped.length} finding(s) (see the JSON report).`,
    );
  }
  if (incomplete.length > 0) {
    lines.push(
      `Incomplete: ${incomplete.length} of ${report.tasks.length} review task(s) did not finish.`,
    );
  }
  const missed = notReviewed - partlyReviewedCount(partly);
  if (missed > 0) {
    const limit = report.spendLimit?.reached
      ? `; the spend limit of $${report.spendLimit.usd} was reached`
      : "";
    lines.push(`Incomplete: ${missed} selected file(s) were not reviewed${limit}.`);
  }
  for (const line of partlyReviewed(partly)) lines.push(`Incomplete: ${line}`);
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  lines.push(`Run: ${report.runId}${sessionDir ? ` (${sessionDir})` : ""}`);
  return forTerminal(`${lines.join("\n")}\n`);
}

function emptyMessage(report: ReviewReport, nothingReviewed: boolean, notReviewed: number): string {
  if (nothingReviewed) return "Nothing was reviewed.";
  if (notReviewed > 0) return "No issues found in the files that were reviewed.";
  const open = report.rereview
    ? report.rereview.notReproduced.length +
      report.rereview.notRechecked.length +
      report.rereview.unchanged.length
    : 0;
  if (open > 0) return `No new issues; ${open} earlier finding(s) are still open.`;
  if (!report.coverage.some((c) => c.status !== "excluded")) {
    return "Nothing to review: no changed file was selected.";
  }
  return "No issues found.";
}

function coverageLine(report: ReviewReport): string {
  const count = (status: string) => report.coverage.filter((c) => c.status === status).length;
  const unreviewed = count("unreviewed");
  const partly = count("incomplete");
  return [
    `Risk tier: ${report.tier}`,
    `${count("reviewed")} reviewed`,
    ...(partly > 0 ? [`${partly} partly reviewed`] : []),
    `${count("failed")} failed`,
    ...(unreviewed > 0 ? [`${unreviewed} not started`] : []),
    ...(count("unchanged") > 0 ? [`${count("unchanged")} unchanged since the last review`] : []),
    `${count("excluded")} excluded`,
  ].join(" · ");
}

function renderFinding(finding: Finding): string[] {
  const location = finding.lineRange
    ? finding.lineRange.start === finding.lineRange.end
      ? `L${finding.lineRange.start}`
      : `L${finding.lineRange.start}-${finding.lineRange.end}`
    : "file";
  const indent = " ".repeat(4);
  const confidence = `${finding.lowConfidence ? " (low confidence)" : ""} [${VERIFICATION[finding.verification ?? "unchecked"]}]`;
  const lines = [
    `  ${finding.severity.padEnd(10)} ${location.padEnd(9)} ${finding.title}${confidence} #${finding.fingerprint.slice(0, 8)}`,
  ];
  lines.push(...indented(finding.body, indent));
  if (finding.suggestion) lines.push(...indented(`Suggestion: ${finding.suggestion}`, indent));
  return lines;
}

function indented(text: string, indent: string): string[] {
  return text.split("\n").map((line) => `${indent}${line}`);
}

function groupByFile(findings: readonly Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();
  for (const finding of [...findings].sort((a, b) => a.file.localeCompare(b.file))) {
    const list = groups.get(finding.file) ?? [];
    list.push(finding);
    groups.set(finding.file, list);
  }
  return groups;
}

function summaryLine(report: ReviewReport): string {
  const counts = SEVERITIES.map(
    (s) => `${report.findings.filter((f) => f.severity === s).length} ${s}`,
  );
  const { inputTokens, cachedTokens, outputTokens, reasoningTokens, costUsd } = report.usage;
  return `${report.findings.length} finding(s) (${counts.join(", ")}) · tokens: ${inputTokens} in (${cachedTokens} cached), ${outputTokens} out, ${reasoningTokens} reasoning · $${costUsd.toFixed(4)}${spendLimit(report)}`;
}

function spendLimit(report: ReviewReport): string {
  const limit = report.spendLimit;
  if (!limit) return "";
  return ` of $${limit.usd}${limit.reached ? " (limit reached)" : ""}`;
}
