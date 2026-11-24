import { z } from "zod";
import type { AttemptRecord, IncompleteEnding, QuotaStop, Usage } from "../contracts.js";
import type { ProjectDocUse } from "../docs/project-docs.js";
import type {
  AnchorMethod,
  ChangeRequest,
  Finding,
  PriorFinding,
  RiskTier,
  TaskFinding,
  Verdict,
} from "../domain.js";
import type { FixSummary } from "../fix/propose.js";
import type { JudgeDecisions } from "../judge/judge.js";
import type { LearningUse } from "../knowledge/learning.js";
import type { SkippedCell } from "../matrix/matrix.js";
import type { RememberedEntry } from "../memory/memory.js";
import type { MergeCheckResult } from "../merge-checks/merge-check.js";
import type { AnalyzerEvidenceUse } from "../sarif/evidence.js";
import type { ExclusionReason } from "../select/select.js";
import type { LinkedTaskUse } from "../task/linked-task.js";
import type { RefutedFinding } from "../verify/verify.js";
import type { Walkthrough } from "../walkthrough/walkthrough.js";
import type { InlineSelection } from "./inline.js";
import type { RunProvenance } from "./provenance.js";
import type { ReviewTrace } from "./trace.js";

// "unchanged": reviewed by an earlier run and not changed since, so not
// reviewed again; its earlier findings carry over. "incomplete": a reviewer's
// task finished without its agent calling the done tool, so the file was at
// most partly reviewed; `ended` says how.
export type CoverageEntry =
  | { path: string; status: "reviewed" | "failed" | "unreviewed" | "unchanged" }
  | { path: string; status: "incomplete"; ended: IncompleteEnding }
  | { path: string; status: "excluded"; reason: ExclusionReason };

// A selected file this run did not finish: the run is incomplete, and the
// next review of a pull or merge request includes it.
export function isUnfinished(entry: CoverageEntry): boolean {
  return (
    entry.status === "failed" || entry.status === "unreviewed" || entry.status === "incomplete"
  );
}

// How much of the selection this run actually reviewed. Every surface (exit
// code, terminal, pull request summary) reads it from here, so none of them
// can call a run that reviewed nothing "approved".
export function coverageGaps(run: {
  coverage: readonly CoverageEntry[];
  tasks: readonly Pick<TaskOutcome, "status">[];
}): {
  // Every unfinished file, those only partly reviewed included.
  notReviewed: number;
  nothingReviewed: boolean;
  incomplete: Record<IncompleteEnding, number>;
} {
  const notReviewed = run.coverage.filter(isUnfinished).length;
  const incomplete = { step_cap: 0, context_window: 0, stopped_early: 0 };
  for (const c of run.coverage) if (c.status === "incomplete") incomplete[c.ended] += 1;
  // Unchanged files were reviewed by an earlier run, and their findings and
  // verdict carry over: a re-review whose new files all failed still has them.
  // A file stays failed while any of its reviewers failed, so a reviewer that
  // finished its tasks has still reviewed something (#263).
  const reviewed =
    run.coverage.some((c) => c.status === "reviewed" || c.status === "unchanged") ||
    run.tasks.some((t) => t.status === "completed");
  return { notReviewed, nothingReviewed: notReviewed > 0 && !reviewed, incomplete };
}

const REFUSED: Record<QuotaStop, string> = {
  daily_limit: "a daily limit was reached",
  rate_limit: "a rate limit outlasted the run's waits",
};

// What stopped the tasks no model would take, for the line that counts the
// files left unreviewed; empty when quota stopped none.
export function quotaNote(tasks: readonly Pick<TaskOutcome, "quota">[]): string {
  const stop = tasks.some((t) => t.quota === "daily_limit")
    ? "daily_limit"
    : tasks.find((t) => t.quota !== undefined)?.quota;
  return stop ? `; the model provider refused calls because ${REFUSED[stop]}` : "";
}

const NOTHING_REVIEWED = "Nothing was reviewed";
const MAX_QUOTED_ERROR = 300;

// Why a run reviewed nothing, for every surface that shows its summary: the
// models refusing the calls is the reader's to fix (wait, or raise a limit),
// which "no reviewer finished" does not tell them.
export function nothingReviewedSummary(
  tasks: readonly Pick<TaskOutcome, "status" | "error" | "quota">[],
): string {
  const failed = tasks.filter((t) => t.status === "failed");
  const refused = failed.filter((t) => t.quota !== undefined);
  if (failed.length > 0 && refused.length === failed.length) {
    return refused.some((t) => t.quota === "daily_limit")
      ? `${NOTHING_REVIEWED}: the model provider refused every call because ${REFUSED.daily_limit}. Run the review again after the limit resets.`
      : `${NOTHING_REVIEWED}: the model provider refused every call because ${REFUSED.rate_limit}. Run the review again later.`;
  }
  const error = failed.find((t) => t.error !== undefined)?.error;
  if (error !== undefined) {
    const quoted = error.length > MAX_QUOTED_ERROR ? `${error.slice(0, MAX_QUOTED_ERROR)}…` : error;
    return `${NOTHING_REVIEWED}: ${failed.length} review task(s) failed. The first error: ${quoted}`;
  }
  return `${NOTHING_REVIEWED}: no reviewer covered or finished any selected file.`;
}

// An incomplete review: it left an unfinished file or a critical finding
// Verify could not check, so its result must never be read as a pass. The
// exit code (3), SARIF, the pull request summary, the ocra Cloud upload and
// `ocra metrics` all read it from here.
export function isIncompleteReview(run: {
  coverage: readonly CoverageEntry[];
  unverifiedCriticals: number;
}): boolean {
  return run.coverage.some(isUnfinished) || run.unverifiedCriticals > 0;
}

// A verdict that fails the run and requests changes: significant concerns
// that no one entitled to has overridden for this head commit.
export function isBlocking(run: {
  verdict: Verdict;
  changeRequest: Pick<ChangeRequest, "override">;
}): boolean {
  return run.verdict === "significant_concerns" && run.changeRequest.override === undefined;
}

// Critical findings that only cap the verdict at minor issues: none is
// confirmed, so none blocks. Zero while a confirmed one blocks, and
// low-confidence findings do not count toward the verdict at all.
export function unconfirmedCriticals(run: {
  verdict: Verdict;
  findings: readonly Pick<Finding, "severity" | "verification" | "lowConfidence">[];
}): number {
  if (run.verdict === "significant_concerns") return 0;
  return run.findings.filter(
    (f) => f.severity === "critical" && f.verification !== "confirmed" && !f.lowConfidence,
  ).length;
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
  // Every model the task could use was out of quota, so no model reviewed it.
  quota?: QuotaStop;
  // The task finished without its agent calling the done tool: its files
  // count as only partly reviewed.
  ended?: IncompleteEnding;
  findings: number;
  durationMs: number;
  // What the task spent, its share of a plan call included; a finding's
  // cost is its task's.
  usage: Usage;
  // The earlier run this task's result was taken from (--resume): its usage
  // is what that run paid, and this run paid nothing for it.
  reusedFrom?: string;
  // Its agent ended without the done tool and was given one more turn, with
  // only the reporting tools, to report what it had confirmed; findings: how
  // many it reported in that turn.
  wrapUp?: { findings: number };
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
  // The team's learnings its tasks were given (ADR-0037); absent when none applied.
  learnings?: LearningUse[];
  // The tasks linked to the change that its tasks were given (ADR-0052);
  // absent when none were looked up, empty when none are linked.
  linkedTasks?: LinkedTaskUse[];
  // The project documents' sections its tasks were given; absent when none were.
  projectDocs?: ProjectDocUse[];
  // Analyzer results its tasks were given as evidence (ADR-0042).
  analyzerEvidence?: AnalyzerEvidenceUse[];
  // What the judge merged, dropped or recalibrated; absent when it did not run.
  judgement?: JudgeDecisions;
  // Which findings a fix was asked for, and why one was not kept; absent
  // when fixes were off (ADR-0058).
  fixes?: FixSummary;
  // What the change does, for its reviewers; absent when it was off or failed.
  walkthrough?: Walkthrough;
  // Each pre-merge check's outcome, in the order given; absent when none was given.
  mergeChecks?: MergeCheckResult[];
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
  // With an inline comment policy: the findings it holds back from inline
  // comments, which the summary lists instead (ADR-0076).
  inline?: InlineSelection;
  // When the caller supplied its version and configuration hash.
  provenance?: RunProvenance;
  // The coding agent that ran the review tasks, when it was not ocra's own
  // engine (ADR-0083); what ocra posts names it.
  agent?: string;
  // How the run came to its findings, in time (ADR-0081).
  trace?: ReviewTrace;
  usage: Usage;
  warnings: string[];
}

export const REVIEW_STAGES = [
  "select",
  "bundle",
  "plan",
  "review",
  "filter",
  "verify",
  "judge",
  "fix",
] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

export type ReviewEvent =
  | { type: "run_started"; runId: string; changeRequest: ChangeRequest }
  | { type: "stage_started"; stage: ReviewStage }
  | { type: "files_selected"; selected: number; excluded: number; tier: RiskTier }
  // groups: each bundle's files, so a run resumed after this one was killed
  // keeps its bundles (ADR-0031).
  | {
      type: "files_bundled";
      strategy: string;
      bundles: number;
      groups: { label: string; files: string[] }[];
      warnings: string[];
    }
  | { type: "matrix_planned"; tasks: number; skipped: SkippedCell[] }
  | { type: "task_started"; taskId: string; reviewer: string; bundle: string; files: string[] }
  // attempt: what a finished attempt read, searched for and answered.
  | { type: "task_progress"; taskId: string; message: string; attempt?: AttemptRecord }
  | { type: "finding"; taskId: string; finding: Finding }
  // A reported finding the run did not keep: on a file outside the files
  // under review. File and title only, so a later analysis can tell what
  // was lost.
  | {
      type: "finding_dropped";
      taskId: string;
      reason: "outside_review";
      file: string;
      title: string;
    }
  // A completed task's findings as reported, before anchoring, under the key
  // of its inputs, so a later run can reuse them (--resume, ADR-0031).
  | { type: "task_reported"; taskId: string; key: string; findings: TaskFinding[] }
  | { type: "task_finished"; outcome: TaskOutcome }
  | { type: "coverage_settled"; coverage: CoverageEntry[] }
  // One per model call: together they are the run's usage.
  | { type: "usage_reported"; usage: Usage }
  // One per plain completion, for the run's trace (ADR-0081): which agent
  // asked, the model that answered, how long it took and what it spent.
  | {
      type: "model_called";
      agent: string;
      model?: string;
      ms: number;
      usage: Usage;
      failed?: true;
    }
  // One file's findings checked while tasks still run (ADR-0074). kept:
  // with the verifier's answer; refuted and settled: ids. A settled finding
  // is in the report as it is here, whatever the judge decides.
  | {
      type: "findings_verified";
      file: string;
      kept: Finding[];
      refuted: string[];
      settled: string[];
    }
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
