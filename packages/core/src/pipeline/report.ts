import { z } from "zod";
import type { Usage } from "../contracts.js";
import type {
  AnchorMethod,
  ChangeRequest,
  Finding,
  PriorFinding,
  RiskTier,
  Verdict,
} from "../domain.js";
import type { JudgeDecisions } from "../judge/judge.js";
import type { RememberedEntry } from "../memory/memory.js";
import type { ExclusionReason } from "../select/select.js";
import type { RefutedFinding } from "../verify/verify.js";
import type { SkippedCell } from "./matrix.js";
import type { RunProvenance } from "./provenance.js";

// "unchanged": reviewed by an earlier run and not changed since, so not
// reviewed again; its earlier findings carry over.
export type CoverageEntry =
  | { path: string; status: "reviewed" | "failed" | "unreviewed" | "unchanged" }
  | { path: string; status: "excluded"; reason: ExclusionReason };

// How much of the selection this run actually reviewed. Every surface (exit
// code, terminal, pull request summary) reads it from here, so none of them
// can call a run that reviewed nothing "approved".
export function coverageGaps(run: {
  coverage: readonly CoverageEntry[];
  tasks: readonly Pick<TaskOutcome, "status">[];
}): {
  notReviewed: number;
  nothingReviewed: boolean;
} {
  const notReviewed = run.coverage.filter(
    (c) => c.status === "failed" || c.status === "unreviewed",
  ).length;
  // Unchanged files were reviewed by an earlier run, and their findings and
  // verdict carry over: a re-review whose new files all failed still has them.
  // A file stays failed while any of its reviewers failed, so a reviewer that
  // finished its tasks has still reviewed something (#263).
  const reviewed =
    run.coverage.some((c) => c.status === "reviewed" || c.status === "unchanged") ||
    run.tasks.some((t) => t.status === "completed");
  return { notReviewed, nothingReviewed: notReviewed > 0 && !reviewed };
}

export const taskStatusSchema = z.enum(["completed", "failed", "timed_out", "cancelled"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export interface TaskOutcome {
  taskId: string;
  reviewer: string;
  bundle: string;
  files: string[];
  status: TaskStatus;
  error?: string;
  findings: number;
  durationMs: number;
  // What the task spent, its share of a plan call included; a finding's
  // cost is its task's.
  usage: Usage;
}

export interface ReviewReport {
  // The run id: the session directory's name, in every output of the run.
  runId: string;
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
  // Findings the repository's or the account's memory marks as accepted.
  remembered: RememberedEntry[];
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
  anchoring?: AnchoringSummary;
  // With a spend limit: the limit, and whether the run reached it. "review":
  // the review share ran out, so review tasks stopped starting (and running
  // ones stopped); "total": the whole limit, so later verification, judging
  // or relocation may have been skipped.
  spendLimit?: { usd: number; reached?: "review" | "total" };
  // When the caller supplied its version and configuration hash.
  provenance?: RunProvenance;
  usage: Usage;
  warnings: string[];
}

export type ReviewEvent =
  | { type: "run_started"; runId: string; changeRequest: ChangeRequest }
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

// How this run's findings were tied to lines, so a change to anchoring can
// be measured: counts per method, how many stayed file-level because their
// quote fitted several places, and how many relocation calls were paid for.
export interface AnchoringSummary {
  byMethod: Record<AnchorMethod, number>;
  ambiguous: number;
  relocationCalls: number;
}

export function summarizeAnchoring(
  findings: readonly Finding[],
  relocationCalls: number,
): AnchoringSummary {
  const byMethod: Record<AnchorMethod, number> = {
    hunk: 0,
    file: 0,
    cross_file: 0,
    relocated: 0,
    file_level: 0,
  };
  for (const f of findings) byMethod[f.anchor.method] += 1;
  return {
    byMethod,
    ambiguous: findings.filter((f) => f.anchor.ambiguous).length,
    relocationCalls,
  };
}
