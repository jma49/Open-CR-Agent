import type { Finding, ReviewReport, Severity } from "@open-cr-agent/core";
import { forTerminal } from "./terminal.js";

const SEVERITIES: Severity[] = ["critical", "warning", "suggestion"];

export function renderJson(report: ReviewReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderText(report: ReviewReport, sessionDir?: string): string {
  const incomplete = report.tasks.filter((t) => t.status !== "completed");
  const nothingReviewed = report.tasks.length > 0 && incomplete.length === report.tasks.length;
  const lines: string[] = [
    `Review: ${report.changeRequest.title}`,
    coverageLine(report),
    ...(nothingReviewed
      ? ["Verdict: not reached (no review task completed)"]
      : [`Verdict: ${report.verdict.replaceAll("_", " ")}`, ...indented(report.summary, "  ")]),
    "",
  ];

  if (report.findings.length === 0) {
    lines.push(emptyMessage(report.tasks.length, incomplete.length), "");
  } else {
    for (const [file, findings] of groupByFile(report.findings)) {
      lines.push(file);
      for (const finding of findings) lines.push(...renderFinding(finding));
      lines.push("");
    }
  }

  lines.push(summaryLine(report));
  const { refuted } = report;
  if (refuted.length > 0) {
    lines.push(
      `Verification dropped ${refuted.length} finding(s) the code disproves (see the JSON report).`,
    );
  }
  if (report.remembered.length > 0) {
    lines.push(
      `${report.remembered.length} finding(s) matched the repository's memory and were not reported.`,
    );
  }
  const rereview = report.rereview;
  if (rereview) {
    lines.push(
      `Since the last review: ${rereview.fixed.length} fixed, ${rereview.dismissed.length} dismissed by reviewers, ${rereview.notReproduced.length} not reported again but unchanged, ${rereview.notRechecked.length} not re-checked (still open ones count in the verdict).`,
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
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  if (sessionDir) lines.push(`Session: ${sessionDir}`);
  return forTerminal(`${lines.join("\n")}\n`);
}

function emptyMessage(tasks: number, incomplete: number): string {
  if (tasks > 0 && incomplete === tasks) return "Nothing was reviewed: no review task completed.";
  if (incomplete > 0) return "No issues found in the files that were reviewed.";
  return "No issues found.";
}

function coverageLine(report: ReviewReport): string {
  const count = (status: string) => report.coverage.filter((c) => c.status === status).length;
  const unreviewed = count("unreviewed");
  return [
    `Risk tier: ${report.tier}`,
    `${count("reviewed")} reviewed`,
    `${count("failed")} failed`,
    ...(unreviewed > 0 ? [`${unreviewed} not covered by any reviewer`] : []),
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
  const confidence = finding.lowConfidence ? " (low confidence)" : "";
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
  return `${report.findings.length} finding(s) (${counts.join(", ")}) · tokens: ${inputTokens} in (${cachedTokens} cached), ${outputTokens} out, ${reasoningTokens} reasoning · $${costUsd.toFixed(4)}`;
}
