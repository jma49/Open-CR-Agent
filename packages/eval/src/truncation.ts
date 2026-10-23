import type { InstanceResult } from "./results.js";

// How far the scored reviews were cut short, so a measurement of truncated
// reviews reads as one: reviewed PRs whose review was incomplete (exit 3),
// their tasks that ended at the step cap, were stopped by the per-PR spend
// cap or ran out of time (their own or the run's); and PRs that failed on
// the provider's rate limit.
export interface Truncation {
  reviewed: number;
  incomplete: number;
  tasks: number;
  stepCap: number;
  spendCap: number;
  timedOut: number;
  rateLimited: number;
}

type Task = InstanceResult["tasks"][number];

// ocra's words for a task the spend limit stopped ("stopped at the spend
// limit of $2") or kept from starting ("spend limit of $2 reached").
const SPEND_CAP = /spend limit of \$/;
// ocra's words for a task its run's timeout stopped or kept from starting;
// in a review that was not interrupted (exit 130), nothing else cancels one.
const RUN_CANCELLED = /^run cancelled/;

// A task stopped by its own timeout or, in a review that was not
// interrupted, by the run's.
export function timedOut(task: Task): boolean {
  return (
    task.status === "timed_out" ||
    (task.status === "cancelled" && RUN_CANCELLED.test(task.error ?? ""))
  );
}

export function truncationOf(results: readonly InstanceResult[]): Truncation {
  const reviewed = results.filter((r) => r.status === "reviewed");
  const tasks = reviewed.flatMap((r) => r.tasks);
  return {
    reviewed: reviewed.length,
    incomplete: reviewed.filter((r) => r.exitCode === 3).length,
    tasks: tasks.length,
    stepCap: tasks.filter((t) => t.ended === "step_cap").length,
    spendCap: tasks.filter((t) => t.status === "cancelled" && SPEND_CAP.test(t.error ?? "")).length,
    timedOut: tasks.filter(timedOut).length,
    rateLimited: results.filter((r) => r.cutShortBy?.includes("rate_limit")).length,
  };
}

export function renderTruncation(t: Truncation): string {
  const pct = (n: number, of: number) => `${of === 0 ? "0.0" : ((n / of) * 100).toFixed(1)}%`;
  const retry =
    t.rateLimited > 0
      ? `; ${t.rateLimited} PR(s) failed on the provider's rate limit (--retry-failed reviews them again)`
      : "";
  return `- Cut short: ${t.incomplete} of ${t.reviewed} reviewed PR(s) incomplete, exit 3 (${pct(t.incomplete, t.reviewed)}); of their ${t.tasks} task(s), ${t.stepCap} at the step cap (${pct(t.stepCap, t.tasks)}), ${t.spendCap} at the spend cap (${pct(t.spendCap, t.tasks)}), ${t.timedOut} timed out (${pct(t.timedOut, t.tasks)})${retry}`;
}
