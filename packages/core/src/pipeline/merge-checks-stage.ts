import { roleCall } from "../agent/settings.js";
import type { Usage } from "../contracts.js";
import type { MergeCheckResult } from "../merge-checks/merge-check.js";
import { judgeMergeChecks, notJudged } from "../merge-checks/merge-checks.js";
import type { StageContext } from "./execute-stage.js";

export interface MergeChecksStage {
  results: MergeCheckResult[];
  usage: Usage[];
  warnings: string[];
}

// Runs beside the review tasks: it reads only the plan, and never rejects.
export async function mergeChecksStage({
  options,
  plan,
  spendLimit,
  signal,
}: StageContext): Promise<MergeChecksStage> {
  const checks = options.mergeChecks ?? [];
  if (checks.length === 0) return { results: [], usage: [], warnings: [] };
  if (!spendLimit.mayCall())
    return { ...notJudged(checks, "the spend limit was reached"), usage: [] };
  const usage: Usage[] = [];
  const result = await judgeMergeChecks({
    runtime: options.runtime,
    changeRequest: plan.changeRequest,
    files: plan.selected,
    checks,
    signal,
    onUsage: (u) => {
      usage.push(u);
      spendLimit.charge(u);
    },
    call: roleCall("judge", options),
  });
  return { ...result, usage };
}
