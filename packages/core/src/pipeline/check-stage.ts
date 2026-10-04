import { roleCall } from "../agent/settings.js";
import type { Usage } from "../contracts.js";
import { type JudgeResult, judgeFindings } from "../judge/judge.js";
import { stillOpen } from "../rereview/reconcile.js";
import { markUnchecked, type VerificationResult, verifyFindings } from "../verify/verify.js";
import type { StageContext } from "./execute-stage.js";
import type { FilterStage } from "./filter-stage.js";
import { REVIEW_DEFAULTS } from "./options.js";

export interface CheckStage {
  verification: VerificationResult;
  judged: JudgeResult;
  usage: Usage[];
  warnings: string[];
}

// Verify fact-checks the findings, then the judge merges, filters and
// recalibrates them and gives the verdict.
export async function checkStage(
  filtered: FilterStage,
  context: StageContext,
): Promise<CheckStage> {
  const verification = await verify(filtered, context);
  const judged = await judge(verification, filtered, context);
  return {
    verification,
    judged,
    usage: [...verification.usage, ...judged.usage],
    warnings: [...verification.warnings, ...judged.warnings],
  };
}

async function verify(
  { reconciled }: FilterStage,
  { options, plan, budget, signal, emit }: StageContext,
): Promise<VerificationResult> {
  if (options.stages?.verify === false) {
    return {
      checked: 0,
      kept: markUnchecked(reconciled.findings),
      refuted: [],
      missed: [],
      usage: [],
      warnings: [],
    };
  }
  const verification = await verifyFindings(reconciled.findings, {
    runtime: options.runtime,
    diffs: plan.selected,
    context: plan.context,
    signal,
    concurrency: options.limits?.concurrency ?? REVIEW_DEFAULTS.concurrency,
    budget,
    call: roleCall("verifier", options),
  });
  if (verification.checked > 0) {
    emit({
      type: "verification_finished",
      checked: verification.checked,
      refuted: verification.refuted,
    });
  }
  return verification;
}

async function judge(
  verification: VerificationResult,
  { reconciled, nothingReviewed }: FilterStage,
  { options, plan, budget, signal, emit }: StageContext,
): Promise<JudgeResult> {
  const wanted = options.stages?.judge !== false && verification.kept.length > 0;
  const affordable = !budget.exhausted();
  const judged = await judgeFindings(verification.kept, {
    runtime: options.runtime,
    changeRequest: plan.changeRequest,
    tier: plan.tier,
    signal,
    call: roleCall("judge", options),
    enabled: wanted && affordable,
    keepDropped: options.mode?.ultra === true,
    carried: stillOpen(reconciled),
  });
  if (wanted && !affordable) {
    judged.warnings.push(
      `spend limit of $${options.limits?.maxCostUsd} reached: findings were not judged`,
    );
  }
  if (!nothingReviewed) {
    emit(
      judged.decisions
        ? { type: "judge_finished", verdict: judged.verdict, judgement: judged.decisions }
        : { type: "judge_finished", verdict: judged.verdict },
    );
  }
  return judged;
}
