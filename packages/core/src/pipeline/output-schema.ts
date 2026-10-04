import { z } from "zod";
import { EFFORT_LEVELS } from "../agent/settings.js";
import { MODEL_TIERS } from "../contracts.js";
import {
  anchorMethodSchema,
  riskTierSchema,
  severitySchema,
  verdictSchema,
  verificationSchema,
} from "../domain.js";
import { memoryEntrySchema } from "../memory/memory.js";
import { exclusionReasonSchema } from "../select/select.js";
import { skipReasonSchema } from "./matrix.js";
import { REPORT_VERSION, type ReportOutput } from "./output.js";
import { taskStatusSchema } from "./report.js";

// The JSON report as a schema: what `toReportOutput` writes, no more. Every
// object is strict, so a field added to the output without a schema change
// fails the tests, and the published JSON Schema (docs/schema/report.v1.json)
// is generated from here, never written by hand.

const usageSchema = z.strictObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cachedTokens: z.number(),
  costUsd: z.number(),
});

const changeRequestSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  override: z.strictObject({ by: z.string(), reason: z.string() }).optional(),
});

const coverageEntrySchema = z.discriminatedUnion("status", [
  z.strictObject({
    path: z.string(),
    status: z.enum(["reviewed", "failed", "unreviewed", "unchanged"]),
  }),
  z.strictObject({
    path: z.string(),
    status: z.literal("excluded"),
    reason: exclusionReasonSchema,
  }),
]);

const linesSchema = z.strictObject({ start: z.int().positive(), end: z.int().positive() });

const fixSchema = z
  .strictObject({
    startLine: z.int().positive(),
    endLine: z.int().positive(),
    replacement: z.string(),
  })
  .refine((f) => f.endLine >= f.startLine, { message: "endLine is before startLine" });

export const outputFindingSchema = z.strictObject({
  fingerprint: z.string(),
  reviewer: z.string(),
  category: z.string(),
  severity: severitySchema,
  verification: verificationSchema,
  file: z.string(),
  lines: linesSchema.optional(),
  inDiff: z.boolean(),
  status: z.enum(["new", "unfixed"]),
  title: z.string(),
  body: z.string(),
  suggestion: z.string().optional(),
  fix: fixSchema.optional(),
  evidence: z.array(z.string()),
  code: z.string(),
  lowConfidence: z.literal(true).optional(),
  provenance: z.strictObject({ task: z.string(), model: z.string().optional() }).optional(),
});

const outputPriorFindingSchema = z.strictObject({
  fingerprint: z.string(),
  title: z.string(),
  file: z.string(),
  severity: severitySchema,
  verification: verificationSchema,
  reviewer: z.string().optional(),
});

const refutedFindingSchema = z.strictObject({
  fingerprint: z.string(),
  file: z.string(),
  title: z.string(),
  reason: z.string(),
});

const judgeDecisionsSchema = z.strictObject({
  merged: z.array(z.strictObject({ kept: z.string(), merged: z.array(z.string()) })),
  dropped: z.array(
    z.strictObject({
      fingerprint: z.string(),
      file: z.string(),
      title: z.string(),
      reason: z.string(),
    }),
  ),
  recalibrated: z.array(
    z.strictObject({
      fingerprint: z.string(),
      from: severitySchema,
      to: severitySchema,
      reason: z.string(),
    }),
  ),
});

const taskOutcomeSchema = z.strictObject({
  taskId: z.string(),
  reviewer: z.string(),
  bundle: z.string(),
  files: z.array(z.string()),
  status: taskStatusSchema,
  error: z.string().optional(),
  findings: z.int().nonnegative(),
  durationMs: z.number(),
  usage: usageSchema,
});

const skippedCellSchema = z.strictObject({
  reviewer: z.string(),
  bundle: z.string(),
  reason: skipReasonSchema,
});

const anchoringSummarySchema = z.strictObject({
  byMethod: z.record(anchorMethodSchema, z.int().nonnegative()),
  ambiguous: z.int().nonnegative(),
  relocationCalls: z.int().nonnegative(),
});

const scopeSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("incremental"), since: z.string() }),
  z.strictObject({ mode: z.literal("full"), reason: z.string() }),
]);

const priorList = z.array(outputPriorFindingSchema);

const samplingSchema = z.strictObject({
  temperature: z.number().optional(),
  seed: z.int().optional(),
  notApplied: z.array(z.enum(["temperature", "seed"])).optional(),
});

const agentProvenanceSchema = z.strictObject({
  tier: z.enum(MODEL_TIERS),
  models: z.array(z.string()).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  applied: z.boolean().optional(),
  notApplied: z.array(z.enum(["temperature", "seed"])).optional(),
});

const provenanceSchema = z.strictObject({
  ocraVersion: z.string(),
  promptHash: z.string(),
  configHash: z.string(),
  sampling: samplingSchema,
  agents: z.record(z.string(), agentProvenanceSchema).optional(),
  rules: z
    .array(
      z.strictObject({
        path: z.array(z.string()),
        rule: z.string(),
        source: z.enum(["repository", "shared", "account", "plugin"]).optional(),
      }),
    )
    .optional(),
  accountSettings: z.strictObject({ version: z.string().nullable() }).optional(),
});

export const reportOutputSchema = z.strictObject({
  version: z.literal(REPORT_VERSION),
  runId: z.string().optional(),
  changeRequest: changeRequestSchema,
  tier: riskTierSchema,
  verdict: verdictSchema,
  summary: z.string(),
  scope: scopeSchema.optional(),
  coverage: z.array(coverageEntrySchema),
  findings: z.array(outputFindingSchema),
  unverifiedCriticals: z.int().nonnegative(),
  refuted: z.array(refutedFindingSchema),
  remembered: z.array(
    memoryEntrySchema.extend({ source: z.enum(["repository", "account"]).optional() }),
  ),
  judgement: judgeDecisionsSchema.optional(),
  rereview: z
    .strictObject({
      fixed: priorList,
      notReproduced: priorList,
      notRechecked: priorList,
      unchanged: priorList,
      dismissed: priorList,
    })
    .optional(),
  tasks: z.array(taskOutcomeSchema),
  skipped: z.array(skippedCellSchema),
  bundles: z.array(z.strictObject({ label: z.string(), files: z.array(z.string()) })),
  anchoring: anchoringSummarySchema.optional(),
  spendLimit: z
    .strictObject({ usd: z.number(), reached: z.enum(["review", "total"]).optional() })
    .optional(),
  provenance: provenanceSchema.optional(),
  usage: usageSchema,
  warnings: z.array(z.string()),
});

// Every field the output type has must be in the schema with a compatible
// type (the strict parse of a full report in the tests covers the other
// direction: nothing in the schema the output does not write).
type OutputFromSchema = z.output<typeof reportOutputSchema>;
export function asSchemaOutput(output: ReportOutput): OutputFromSchema {
  return output;
}

export const REPORT_SCHEMA_ID = "https://ocra.majincheng.com/schema/report.v1.json";

// JSON Schema (draft 2020-12) for `--format json` and a session's
// report.json, for validators and code generators outside this codebase.
export function reportJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(reportOutputSchema, { target: "draft-2020-12", io: "output" });
  const { $schema, ...rest } = generated;
  return {
    $schema,
    $id: REPORT_SCHEMA_ID,
    title: "ocra review report",
    description: `The report ocra writes with --format json and as a session's report.json (version ${REPORT_VERSION}). A version only gains optional fields; anything else is a new version.`,
    ...rest,
  };
}
