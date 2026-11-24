import { coverageGaps, MAX_AGENT_STEPS, type ReviewReport } from "@open-cr-agent/core";
import { quotaNote, unconfirmedCriticals } from "@open-cr-agent/core/internal";
import type { PlatformText } from "./render.js";

// Unverified criticals that cap the verdict, and what the run did not check.
export function incompleteNotes(report: ReviewReport, text: PlatformText): string[] {
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
  const missed =
    notReviewed - incomplete.step_cap - incomplete.context_window - incomplete.stopped_early;
  if (missed > 0) {
    const limit = report.spendLimit?.reached
      ? `; the spend limit of $${report.spendLimit.usd} was reached`
      : quotaNote(report.tasks);
    gaps.push(`**Incomplete:** ${missed} selected file(s) were not reviewed${limit}.`);
  }
  if (incomplete.step_cap > 0) {
    gaps.push(
      `**Incomplete:** ${incomplete.step_cap} selected file(s) were only partly reviewed: a reviewer used all ${MAX_AGENT_STEPS} of its steps before it finished them. The step limit is fixed; a smaller ${text.changeRequest} gives each file more of them.`,
    );
  }
  if (incomplete.context_window > 0) {
    gaps.push(
      `**Incomplete:** ${incomplete.context_window} selected file(s) were only partly reviewed: a reviewer filled its model's context window before it finished them. A smaller ${text.changeRequest}, or a model with a larger window, leaves each file more room.`,
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
