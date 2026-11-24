import {
  coverageGaps,
  type Finding,
  isBlocking,
  isIncompleteReview,
  type ReviewReport,
  type Severity,
} from "@open-cr-agent/core";
import { byline } from "./byline.js";
import { codeSpan, safeLine } from "./render.js";

// How a review ended, as a check on the change request's head commit: a
// verdict line for the checks list and the findings as one table. It never
// fails: the verdict is advice, not a gate a required check could enforce.
export interface CheckOutcome {
  conclusion: "success" | "neutral" | "cancelled";
  title: string;
  summary: string;
}

const MAX_TITLE_CHARS = 120;
const MAX_ROWS = 50;
const ORDER: readonly Severity[] = ["critical", "warning", "suggestion"];
const LABEL: Record<Severity, string> = {
  critical: "🔴 Critical",
  warning: "🟠 Warning",
  suggestion: "🔵 Suggestion",
};
const VERDICT: Record<ReviewReport["verdict"], string> = {
  approved: "Approved",
  approved_with_comments: "Approved with comments",
  minor_issues: "Minor issues",
  significant_concerns: "Significant concerns",
};

export function checkOutcome(report: ReviewReport): CheckOutcome {
  const findings = report.findings.filter((f) => !f.lowConfidence);
  if (coverageGaps(report).nothingReviewed) {
    return {
      conclusion: "neutral",
      title: `${agentPrefix(report)}Not reviewed`,
      summary: "Nothing was reviewed. The summary comment on the pull request says why.",
    };
  }
  const passes = !isBlocking(report) && report.verdict !== "minor_issues";
  const incomplete = isIncompleteReview(report) ? " · incomplete" : "";
  return {
    conclusion: passes ? "success" : "neutral",
    title: clip(
      `${agentPrefix(report)}${VERDICT[report.verdict]} · ${counts(findings)}${incomplete}`,
    ),
    summary: findings.length === 0 ? "No issues found." : table(findings),
  };
}

export function runningOutcome(headSha: string): Pick<CheckOutcome, "title" | "summary"> {
  return {
    title: "Reviewing",
    summary: `ocra is reviewing ${codeSpan(headSha.slice(0, 7))}. Its findings appear on the pull request when it finishes.`,
  };
}

export function stoppedOutcome(reason: string): CheckOutcome {
  return { conclusion: "cancelled", title: "Stopped", summary: safeLine(reason) };
}

function agentPrefix(report: ReviewReport): string {
  return report.agent ? `${byline(report.agent)} · ` : "";
}

function counts(findings: readonly Finding[]): string {
  if (findings.length === 0) return "no issues";
  return ORDER.flatMap((severity) => {
    const n = findings.filter((f) => f.severity === severity).length;
    return n === 0 ? [] : [`${n} ${severity}${n === 1 ? "" : "s"}`];
  }).join(", ");
}

function table(findings: readonly Finding[]): string {
  const sorted = [...findings].sort(
    (a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity),
  );
  const rows = sorted
    .slice(0, MAX_ROWS)
    .map(
      (f) => `| ${LABEL[f.severity]} | ${cell(codeSpan(where(f)))} | ${cell(safeLine(f.title))} |`,
    );
  const more = sorted.length - rows.length;
  return [
    "| Severity | Where | Finding |",
    "|---|---|---|",
    ...rows,
    ...(more > 0 ? ["", `${more} more in the summary comment.`] : []),
  ].join("\n");
}

function where(f: Finding): string {
  if (!f.lineRange) return f.file;
  const { start, end } = f.lineRange;
  return `${f.file}:${start === end ? start : `${start}-${end}`}`;
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function clip(text: string): string {
  return text.length <= MAX_TITLE_CHARS ? text : `${text.slice(0, MAX_TITLE_CHARS - 1)}…`;
}
