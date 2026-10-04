import { z } from "zod";
import { EFFORT_LEVELS } from "../agent/settings.js";
import { riskTierSchema } from "../domain.js";
import { changeRequestSchema, skippedCellSchema } from "../report/output-schema.js";
import { exclusionReasonSchema } from "../select/select.js";
import type { PreviewTask, ReviewPreview } from "./preview.js";

// The published shape of `ocra review --plan --format json` without what
// the CLI adds (where each setting came from), versioned like the report: a
// version only gains optional fields. The type is derived from the schema,
// and the CLI publishes the JSON Schema of the whole output.
export const PLAN_VERSION = 1;

const inputCostSchema = z.discriminatedUnion("status", [
  z.strictObject({ model: z.string(), status: z.literal("priced"), usd: z.number() }),
  z.strictObject({ model: z.string(), status: z.literal("unpriced") }),
  z.strictObject({ model: z.string(), status: z.literal("unknown") }),
]);

const planTaskSchema = z.strictObject({
  taskId: z.string(),
  reviewer: z.string(),
  bundle: z.string(),
  files: z.array(z.string()),
  promptTokens: z.int().nonnegative(),
  effort: z.enum(EFFORT_LEVELS).exactOptional(),
  models: z.array(z.string()).exactOptional(),
  planPromptTokens: z.int().nonnegative().exactOptional(),
  inputCost: inputCostSchema.exactOptional(),
});

export const planOutputSchema = z.strictObject({
  version: z.literal(PLAN_VERSION),
  changeRequest: changeRequestSchema,
  tier: riskTierSchema,
  selected: z.array(z.string()),
  excluded: z.array(z.strictObject({ path: z.string(), reason: exclusionReasonSchema })),
  bundles: z.array(z.strictObject({ label: z.string(), files: z.array(z.string()) })),
  groupingSkipped: z.boolean(),
  tasks: z.array(planTaskSchema),
  skipped: z.array(skippedCellSchema),
  promptTokens: z.int().nonnegative(),
  // Added in version 1 without a bump: a new field older readers ignore.
  planCalls: z.int().nonnegative(),
  // Added in version 1 without a bump, like planCalls.
  inputCost: z
    .strictObject({
      usd: z.number(),
      priced: z.int().nonnegative(),
      unpriced: z.int().nonnegative(),
      unknown: z.int().nonnegative(),
    })
    .exactOptional(),
  warnings: z.array(z.string()),
});

export type PlanOutput = z.output<typeof planOutputSchema>;
type PlanTask = PlanOutput["tasks"][number];

export function toPlanOutput(preview: ReviewPreview): PlanOutput {
  const { changeRequest: c, inputCost } = preview;
  return {
    version: PLAN_VERSION,
    changeRequest: {
      id: c.id,
      title: c.title,
      description: c.description,
      baseSha: c.baseSha,
      headSha: c.headSha,
      ...(c.override ? { override: { by: c.override.by, reason: c.override.reason } } : {}),
    },
    tier: preview.tier,
    selected: [...preview.selected],
    excluded: preview.excluded.map((e) => ({ path: e.path, reason: e.reason })),
    bundles: preview.bundles.map((b) => ({ label: b.label, files: [...b.files] })),
    groupingSkipped: preview.groupingSkipped,
    tasks: preview.tasks.map(planTask),
    skipped: preview.skipped.map((s) => ({
      reviewer: s.reviewer,
      bundle: s.bundle,
      reason: s.reason,
    })),
    promptTokens: preview.promptTokens,
    planCalls: preview.planCalls,
    ...(inputCost
      ? {
          inputCost: {
            usd: inputCost.usd,
            priced: inputCost.priced,
            unpriced: inputCost.unpriced,
            unknown: inputCost.unknown,
          },
        }
      : {}),
    warnings: [...preview.warnings],
  };
}

function planTask(t: PreviewTask): PlanTask {
  const cost = t.inputCost;
  return {
    taskId: t.taskId,
    reviewer: t.reviewer,
    bundle: t.bundle,
    files: [...t.files],
    promptTokens: t.promptTokens,
    ...(t.effort === undefined ? {} : { effort: t.effort }),
    ...(t.models ? { models: [...t.models] } : {}),
    ...(t.planPromptTokens === undefined ? {} : { planPromptTokens: t.planPromptTokens }),
    ...(cost
      ? {
          inputCost:
            cost.status === "priced"
              ? { model: cost.model, status: cost.status, usd: cost.usd }
              : { model: cost.model, status: cost.status },
        }
      : {}),
  };
}
