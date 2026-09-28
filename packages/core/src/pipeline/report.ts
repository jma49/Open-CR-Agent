import type { Usage } from "../contracts.js";
import type { ChangeRequest, Finding, PriorFinding, RiskTier, Verdict } from "../domain.js";
import type { JudgeDecisions } from "../judge/judge.js";
import type { MemoryEntry } from "../memory/memory.js";
import type { ExclusionReason } from "../select/select.js";
import type { RefutedFinding } from "../verify/verify.js";
import type { SkippedCell } from "./matrix.js";

// "unchanged": reviewed by an earlier run and not changed since, so not
// reviewed again; its earlier findings carry over.
export type CoverageEntry =
  | { path: string; status: "reviewed" | "failed" | "unreviewed" | "unchanged" }
  | { path: string; status: "excluded"; reason: ExclusionReason };

// How much of the selection this run actually reviewed. Every surface (exit
// code, terminal, pull request summary) reads it from here, so none of them
// can call a run that reviewed nothing "approved".
export function coverageGaps(coverage: readonly CoverageEntry[]): {
  notReviewed: number;
  nothingReviewed: boolean;
} {
  const notReviewed = coverage.filter(
    (c) => c.status === "failed" || c.status === "unreviewed",
  ).length;
  // Unchanged files were reviewed by an earlier run, and their findings and
  // verdict carry over: a re-review whose new files all failed still has them.
  const reviewed = coverage.some((c) => c.status === "reviewed" || c.status === "unchanged");
  return { notReviewed, nothingReviewed: notReviewed > 0 && !reviewed };
}

export type TaskStatus = "completed" | "failed" | "timed_out" | "cancelled";

export interface TaskOutcome {
  taskId: string;
  reviewer: string;
  bundle: string;
  files: string[];
  status: TaskStatus;
  error?: string;
  findings: number;
  durationMs: number;
}

export interface ReviewReport {
  changeRequest: ChangeRequest;
  tier: RiskTier;
  verdict: Verdict;
  summary: string;
  coverage: CoverageEntry[];
  bundles: { label: string; files: string[] }[];
  tasks: TaskOutcome[];
  skipped: SkippedCell[];
  findings: Finding[];
  // Critical findings Verify should have checked but could not (it failed,
  // timed out or ran out of budget). With `verify: false` this stays 0.
  unverifiedCriticals: number;
  refuted: RefutedFinding[];
  // Findings the repository's memory marks as accepted.
  remembered: MemoryEntry[];
  // What the judge merged, dropped or recalibrated; absent when it did not run.
  judgement?: JudgeDecisions;
  // With an earlier review: whether this run reviewed only what changed since.
  scope?: { mode: "incremental"; since: string } | { mode: "full"; reason: string };
  // Compared with the previous review of the same change, when there was one.
  rereview?: {
    fixed: PriorFinding[];
    notReproduced: PriorFinding[];
    notRechecked: PriorFinding[];
    unchanged: PriorFinding[];
    dismissed: PriorFinding[];
  };
  usage: Usage;
  warnings: string[];
}

export type ReviewEvent =
  | { type: "run_started"; changeRequest: ChangeRequest }
  | { type: "files_selected"; selected: number; excluded: number; tier: RiskTier }
  | { type: "files_bundled"; strategy: string; bundles: number; warnings: string[] }
  | { type: "matrix_planned"; tasks: number; skipped: SkippedCell[] }
  | { type: "task_started"; taskId: string; reviewer: string; bundle: string; files: string[] }
  | { type: "task_progress"; taskId: string; message: string }
  | { type: "finding"; taskId: string; finding: Finding }
  | { type: "task_finished"; outcome: TaskOutcome }
  | { type: "verification_finished"; checked: number; refuted: RefutedFinding[] }
  | { type: "judge_finished"; verdict: Verdict; judgement?: JudgeDecisions }
  | { type: "run_finished"; report: ReviewReport };
