import { spendLimit } from "../agent/spend-limit.js";
import { OcraError } from "../errors.js";
import type { ReviewReport } from "../report/report.js";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import { assembleReport } from "./assemble-report.js";
import { checkStage } from "./check-stage.js";
import { executeStage, type StageContext } from "./execute-stage.js";
import { filterStage } from "./filter-stage.js";
import { type ReviewHooks, type ReviewOptions, runSettings } from "./options.js";
import { planReview } from "./plan.js";
import { newRunId } from "./run-id.js";

// The library entry: plan (deterministic stages) → execute (one agent task
// per cell) → filter (memory, the previous review) → check (verify, judge)
// → report. The `ocra` command is one caller. The manual's Embedding page
// says which options are a contract.
export function review(options: ReviewOptions): Promise<ReviewReport> {
  return reviewWithHooks(options);
}

export async function reviewWithHooks(options: ReviewOptions & ReviewHooks): Promise<ReviewReport> {
  const settings = runSettings(options);
  const emit = options.onEvent ?? (() => {});
  const timeout = AbortSignal.timeout(settings.runTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const reviewers = options.reviewers ?? [correctnessReviewer];
  if (reviewers.length === 0) throw new OcraError("CONFIG_INVALID", "No reviewer is registered");
  const runId = options.identity?.runId ?? newRunId();

  const plan = await planReview({ ...options, runId, full: settings.full }, emit, signal);
  const context: StageContext = {
    options,
    settings,
    plan,
    spendLimit: spendLimit(settings.maxCostUsd, plan.usage),
    signal,
    emit,
  };
  const executed = await executeStage(reviewers, context);
  const filtered = await filterStage(executed, plan.prior.review, context);
  const checked = await checkStage(filtered, context);
  const report = assembleReport({ runId, reviewers }, { executed, filtered, checked }, context);
  emit({ type: "run_finished", report });
  return report;
}
