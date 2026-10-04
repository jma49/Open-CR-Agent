import { PLAN_VERSION, planOutputSchema } from "@open-cr-agent/core/internal";
import { z } from "zod";

// `ocra review --plan --format json`: core's plan, and where each setting of
// the review came from (ADR-0027). A contract like the report: a version
// only gains optional fields, and docs/schema/plan.v1.json is generated from
// here (npm run schema).
export const cliPlanOutputSchema = planOutputSchema.extend({
  settings: z.array(
    z.strictObject({
      key: z.string(),
      // Absent for a default: ocra's own, or the runtime's.
      value: z.unknown().exactOptional(),
      source: z.string(),
    }),
  ),
  // Present when ocra Cloud account settings were layered under the
  // configuration; null when the account has never saved any.
  accountSettings: z.strictObject({ version: z.string().nullable() }).exactOptional(),
});

export type CliPlanOutput = z.output<typeof cliPlanOutputSchema>;

export const PLAN_SCHEMA_ID = `https://ocra.majincheng.com/schema/plan.v${PLAN_VERSION}.json`;

export function planJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(cliPlanOutputSchema, {
    target: "draft-2020-12",
    io: "output",
    unrepresentable: "any",
  });
  const { $schema, ...rest } = generated;
  return {
    $schema,
    $id: PLAN_SCHEMA_ID,
    title: "ocra review plan",
    description: `What ocra review --plan --format json writes (version ${PLAN_VERSION}): the files, tasks and estimated prompt sizes of a review, before any model call. A version only gains optional fields; anything else is a new version.`,
    ...rest,
  };
}
