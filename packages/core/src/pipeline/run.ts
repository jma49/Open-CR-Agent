import { spendTracker } from "../agent/budget.js";
import type { PriorReview } from "../domain.js";
import { errorMessage, OcraError } from "../errors.js";
import type { ReviewReport } from "../report/report.js";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import type { VcsAdapter } from "../vcs.js";
import { assembleReport } from "./assemble-report.js";
import { checkStage } from "./check-stage.js";
import { executeStage, type StageContext } from "./execute-stage.js";
import { filterStage } from "./filter-stage.js";
import { MAX_TIMER_MS, REVIEW_DEFAULTS, type ReviewHooks, type ReviewOptions } from "./options.js";
import { planReview } from "./plan.js";
import { newRunId } from "./run-id.js";

export { GUIDELINES_PATH } from "./plan.js";

// The library entry: plan (deterministic stages) → execute (one agent task
// per cell) → filter (memory, the previous review) → check (verify, judge)
// → report. The `ocra` command is one caller. The manual's Embedding page
// says which options are a contract.
export function review(options: ReviewOptions): Promise<ReviewReport> {
  return reviewWithHooks(options);
}

export async function reviewWithHooks(options: ReviewOptions & ReviewHooks): Promise<ReviewReport> {
  const emit = options.onEvent ?? (() => {});
  const timeout = AbortSignal.timeout(
    Math.min(options.limits?.runTimeoutMs ?? REVIEW_DEFAULTS.runTimeoutMs, MAX_TIMER_MS),
  );
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const reviewers = options.reviewers ?? [correctnessReviewer];
  if (reviewers.length === 0) throw new OcraError("CONFIG_INVALID", "No reviewer is registered");
  const runId = options.identity?.runId ?? newRunId();

  const prior = await loadPriorReview(options.vcs);
  const scope = reviewScope(prior.review, options.mode?.full === true);
  const plan = await planReview(
    scope.only
      ? {
          ...options,
          runId,
          reviewOnly: scope.only,
          ...(prior.review?.tier ? { priorTier: prior.review.tier } : {}),
        }
      : { ...options, runId },
    emit,
    signal,
  );
  const budget = spendTracker(options.limits?.maxCostUsd, plan.usage);
  const context: StageContext = { options, plan, budget, signal, emit };
  const executed = await executeStage(reviewers, context);
  const filtered = await filterStage(executed, prior.review, context);
  const checked = await checkStage(filtered, context);
  const report = assembleReport(
    { runId, reviewers, prior, scopeNote: scope.note },
    { executed, filtered, checked },
    context,
  );
  emit({ type: "run_finished", report });
  return report;
}

// Review only what changed since the earlier review when the platform can
// tell; otherwise everything, with the reason in the report.
function reviewScope(
  review: PriorReview | undefined,
  full: boolean,
): { only?: ReadonlySet<string>; note?: NonNullable<ReviewReport["scope"]> } {
  if (!review) return {};
  if (full) return { note: { mode: "full", reason: "a full review was requested" } };
  if (review.changedSince) {
    return {
      only: new Set(review.changedSince.files),
      note: { mode: "incremental", since: review.changedSince.head },
    };
  }
  const reason = review.fullReviewReason ?? "the platform cannot tell what changed since";
  return { note: { mode: "full", reason } };
}

// A missing earlier review only costs the comparison, never the review.
async function loadPriorReview(
  vcs: VcsAdapter,
): Promise<{ review?: PriorReview; warning?: string }> {
  try {
    const review = await vcs.getPriorReview();
    return review ? { review } : {};
  } catch (error) {
    return { warning: `could not load the previous review: ${errorMessage(error)}` };
  }
}
