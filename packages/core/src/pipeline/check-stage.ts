import { roleCall } from "../agent/settings.js";
import type { Usage } from "../contracts.js";
import { type JudgeResult, judgeFindings } from "../judge/judge.js";
import { stillOpen } from "../rereview/reconcile.js";
import { type EarlyVerification, verifyRemaining } from "../verify/early.js";
import { markUnchecked, type VerificationResult } from "../verify/verify.js";
import type { EarlyCheck } from "./early-check.js";
import { type StageContext, verifyOptions } from "./execute-stage.js";
import type { FilterStage } from "./filter-stage.js";

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
  early: EarlyCheck | undefined,
  context: StageContext,
): Promise<CheckStage> {
  context.emit({ type: "stage_started", stage: "verify" });
  const checked = await early?.result();
  const verification = hidePreExisting(
    await verify(filtered, checked?.verification, context),
    context.settings,
  );
  context.emit({ type: "stage_started", stage: "judge" });
  const judged = await judge(verification, filtered, checked?.settled, context);
  for (const usage of judged.usage) context.spendLimit.charge(usage);
  return {
    verification,
    judged,
    usage: [...verification.usage, ...judged.usage],
    warnings: [...verification.warnings, ...judged.warnings],
  };
}

async function verify(
  { reconciled }: FilterStage,
  early: EarlyVerification | undefined,
  context: StageContext,
): Promise<VerificationResult> {
  const { settings, emit } = context;
  if (!settings.verify) {
    return {
      checked: 0,
      kept: markUnchecked(reconciled.findings),
      refuted: [],
      missed: [],
      usage: [],
      warnings: [],
    };
  }
  const verification = await verifyRemaining(reconciled.findings, early, verifyOptions(context));
  if (verification.checked > 0) {
    emit({
      type: "verification_finished",
      checked: verification.checked,
      refuted: verification.refuted,
    });
  }
  return verification;
}

function hidePreExisting(
  verification: VerificationResult,
  settings: StageContext["settings"],
): VerificationResult {
  if (settings.showPreExisting) return verification;
  const kept = verification.kept.filter((f) => !f.preExisting);
  const hidden = verification.kept.length - kept.length;
  if (hidden === 0) return verification;
  return {
    ...verification,
    kept,
    warnings: [
      ...verification.warnings,
      `${hidden} pre-existing finding(s) not shown (showPreExisting is false)`,
    ],
  };
}

async function judge(
  verification: VerificationResult,
  { reconciled, nothingReviewed }: FilterStage,
  settled: ReadonlySet<string> | undefined,
  { options, settings, plan, spendLimit, signal, emit }: StageContext,
): Promise<JudgeResult> {
  const wanted = settings.judge && verification.kept.length > 0;
  const affordable = spendLimit.mayCall();
  const judged = await judgeFindings(verification.kept, {
    runtime: options.runtime,
    changeRequest: plan.changeRequest,
    tier: plan.tier,
    signal,
    call: roleCall("judge", options),
    enabled: wanted && affordable,
    keepDropped: settings.ultra,
    carried: stillOpen(reconciled),
    ...(settled ? { settled } : {}),
  });
  if (wanted && !affordable) {
    judged.warnings.push(
      `spend limit of $${settings.maxCostUsd} reached: findings were not judged`,
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
