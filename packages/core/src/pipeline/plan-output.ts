import type { ReviewPreview } from "./preview.js";

// The published shape of `ocra review --plan --format json`, versioned like
// the report. The preview is already free of internal fields; the version
// makes the contract explicit.
export const PLAN_VERSION = 1;

export type PlanOutput = { version: typeof PLAN_VERSION } & ReviewPreview;

export function toPlanOutput(preview: ReviewPreview): PlanOutput {
  return {
    version: PLAN_VERSION,
    changeRequest: preview.changeRequest,
    tier: preview.tier,
    selected: preview.selected,
    excluded: preview.excluded,
    bundles: preview.bundles,
    groupingSkipped: preview.groupingSkipped,
    tasks: preview.tasks,
    skipped: preview.skipped,
    promptTokens: preview.promptTokens,
    // Added in version 1 without a bump: a new field older readers ignore.
    planCalls: preview.planCalls,
    // Added in version 1 without a bump, like planCalls.
    ...(preview.inputCost ? { inputCost: preview.inputCost } : {}),
    warnings: preview.warnings,
  };
}
