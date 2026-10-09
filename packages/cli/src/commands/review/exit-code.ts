import {
  coverageGaps,
  isBlocking,
  isIncompleteReview,
  type ReviewReport,
} from "@open-cr-agent/core";
import { EXIT } from "../../io/exit.js";
import type { Output } from "../../io/output.js";
import { forTerminal } from "../../io/terminal.js";
import { partlyReviewed, partlyReviewedCount } from "./partly-reviewed.js";

export function exitCode(report: ReviewReport, err: Output): number {
  if (report.tasks.length > 0 && report.tasks.every((t) => t.status !== "completed")) {
    err.write("[ocra] No review task completed; see the errors above.\n");
    return EXIT.error;
  }
  // Incomplete comes first, even over a blocking verdict: the action lets
  // exit 1 pass unless fail-on-concerns is set, and a review that missed
  // files or could not check a critical finding must never pass.
  if (isIncompleteReview(report)) {
    for (const line of incompleteLines(report)) err.write(`[ocra] ${line}\n`);
    return EXIT.incomplete;
  }
  if (isBlocking(report)) return EXIT.blocking;
  const override = report.changeRequest.override;
  if (report.verdict === "significant_concerns" && override) {
    err.write(
      `[ocra] The blocking verdict was overridden by ${forTerminal(override.by)}: ${forTerminal(override.reason)}\n`,
    );
  }
  return EXIT.ok;
}

// Unfinished files say why the review is incomplete before unverified
// critical findings do; the second is said only without the first.
function incompleteLines(report: ReviewReport): string[] {
  const { notReviewed, incomplete } = coverageGaps(report);
  if (notReviewed === 0) {
    return [
      `${report.unverifiedCriticals} critical finding(s) could not be verified; the review is incomplete.`,
    ];
  }
  const missed = notReviewed - partlyReviewedCount(incomplete);
  return [
    ...(missed > 0
      ? [`${missed} selected file(s) were not reviewed; the review is incomplete.`]
      : []),
    ...partlyReviewed(incomplete),
  ];
}
