import { spendLimit } from "../agent/spend-limit.js";
import { OcraError } from "../errors.js";
import type { ReviewEvent, ReviewReport } from "../report/report.js";
import { TraceRecorder } from "../report/trace.js";
import { tracedRuntime } from "../report/traced-runtime.js";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import { assembleReport } from "./assemble-report.js";
import { checkStage } from "./check-stage.js";
import { executeStage, type StageContext } from "./execute-stage.js";
import { filterStage } from "./filter-stage.js";
import { fixStage } from "./fix-stage.js";
import { mergeChecksStage } from "./merge-checks-stage.js";
import { type ReviewHooks, type ReviewOptions, runSettings } from "./options.js";
import { planReview } from "./plan.js";
import { newRunId } from "./run-id.js";
import { walkthroughStage } from "./walkthrough-stage.js";

// The library entry: plan (deterministic stages) → execute (one agent task
// per cell, beside the walkthrough and the pre-merge checks) → filter
// (memory, the previous review) → check (verify, which starts while tasks
// still run, and judge) → fix → report. The `ocra`
// command is one caller. The manual's Embedding page says which options are
// a contract.
export function review(options: ReviewOptions): Promise<ReviewReport> {
  return reviewWithHooks(options);
}

export async function reviewWithHooks(given: ReviewOptions & ReviewHooks): Promise<ReviewReport> {
  const reviewers = given.reviewers ?? [correctnessReviewer];
  if (reviewers.length === 0) throw new OcraError("CONFIG_INVALID", "No reviewer is registered");
  const trace = new TraceRecorder();
  const onEvent = given.onEvent ?? (() => {});
  const emit = (event: ReviewEvent) => {
    trace.record(event);
    onEvent(event);
  };
  const options = { ...given, runtime: tracedRuntime(given.runtime, emit) };
  const settings = runSettings(options);
  const timeout = AbortSignal.timeout(settings.runTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const runId = options.identity?.runId ?? newRunId();

  const plan = await planReview(
    { ...options, bundling: options.bundling ?? settings.bundling, runId, full: settings.full },
    emit,
    signal,
  );
  for (const usage of plan.usage) emit({ type: "usage_reported", usage });
  const context: StageContext = {
    options,
    settings,
    plan,
    spendLimit: spendLimit(settings.maxCostUsd, plan.usage, (usage) =>
      emit({ type: "usage_reported", usage }),
    ),
    signal,
    emit,
  };
  const walkthrough = walkthroughStage(context);
  const mergeChecks = mergeChecksStage(context);
  const executed = await executeStage(reviewers, context);
  const filtered = await filterStage(executed, plan.prior.review, context);
  const checked = await checkStage(filtered, executed.early, context);
  const fixed = await fixStage(checked, context);
  const assembled = assembleReport(
    { runId, reviewers },
    {
      executed,
      filtered,
      checked,
      fixed,
      walkthrough: await walkthrough,
      mergeChecks: await mergeChecks,
    },
    context,
  );
  const report = { ...assembled, trace: trace.build(assembled) };
  emit({ type: "run_finished", report });
  return report;
}
