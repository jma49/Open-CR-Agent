import { coverageGaps, type ReviewReport } from "@open-cr-agent/core";
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
  const { notReviewed, incomplete } = coverageGaps(report);
  if (notReviewed > 0) {
    const missed = notReviewed - partlyReviewedCount(incomplete);
    if (missed > 0) {
      err.write(`[ocra] ${missed} selected file(s) were not reviewed; the review is incomplete.\n`);
    }
    for (const line of partlyReviewed(incomplete)) err.write(`[ocra] ${line}\n`);
    return EXIT.incomplete;
  }
  if (report.unverifiedCriticals > 0) {
    err.write(
      `[ocra] ${report.unverifiedCriticals} critical finding(s) could not be verified; the review is incomplete.\n`,
    );
    return EXIT.incomplete;
  }
  if (report.verdict !== "significant_concerns") return EXIT.ok;
  const override = report.changeRequest.override;
  if (!override) return EXIT.blocking;
  err.write(
    `[ocra] The blocking verdict was overridden by ${forTerminal(override.by)}: ${forTerminal(override.reason)}\n`,
  );
  return EXIT.ok;
}
