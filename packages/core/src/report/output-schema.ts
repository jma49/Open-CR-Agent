import { z } from "zod";
import { EFFORT_LEVELS } from "../agent/settings.js";
import { INCOMPLETE_ENDINGS, MODEL_TIERS } from "../contracts.js";
import {
  anchorMethodSchema,
  riskTierSchema,
  severitySchema,
  verdictSchema,
  verificationSchema,
} from "../domain.js";
import { memoryEntrySchema } from "../memory/memory.js";
import { skipReasonSchema } from "../pipeline/matrix.js";
import { exclusionReasonSchema } from "../select/select.js";
import { taskStatusSchema } from "./report.js";

// The published shape of a review: `--format json` and a session's
// report.json. It is a contract with scripts and CI, so it carries a version
// and only what a reader can rely on; internal fields (per-run ids, how each
// finding was anchored, code signatures, platform state) stay out, though the
// anchoring counts of the whole run are in. Change it only by adding optional
// fields, or by a new version.
export const REPORT_VERSION = 1;

// The JSON report as a schema, the one definition of its shape: the
// `ReportOutput` type is derived from it, and the published JSON Schema
// (docs/schema/report.v1.json) is generated from it. Every object is strict,
// so a field `toReportOutput` writes without a schema change fails the tests.

const usageSchema = z.strictObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cachedTokens: z.number(),
  costUsd: z.number(),
});

export const changeRequestSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  override: z.strictObject({ by: z.string(), reason: z.string() }).exactOptional(),
});

const coverageEntrySchema = z.discriminatedUnion("status", [
  z.strictObject({
    path: z.string(),
    status: z.enum(["reviewed", "failed", "unreviewed", "unchanged"]),
  }),
  z.strictObject({
    path: z.string(),
    status: z.literal("incomplete"),
    ended: z.enum(INCOMPLETE_ENDINGS),
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

const outputFindingSchema = z.strictObject({
  fingerprint: z.string(),
  reviewer: z.string(),
  category: z.string(),
  severity: severitySchema,
  verification: verificationSchema,
  file: z.string(),
  lines: linesSchema.exactOptional(),
  inDiff: z.boolean(),
  status: z.enum(["new", "unfixed"]),
  title: z.string(),
  body: z.string(),
  suggestion: z.string().exactOptional(),
  fix: fixSchema.exactOptional(),
  evidence: z.array(z.string()),
  code: z.string(),
  lowConfidence: z.literal(true).exactOptional(),
  provenance: z
    .strictObject({ task: z.string(), model: z.string().exactOptional() })
    .exactOptional(),
});

const outputPriorFindingSchema = z.strictObject({
  fingerprint: z.string(),
  title: z.string(),
  file: z.string(),
  severity: severitySchema,
  verification: verificationSchema,
  reviewer: z.string().exactOptional(),
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

export const taskOutcomeSchema = z.strictObject({
  taskId: z.string(),
  reviewer: z.string(),
  bundle: z.string(),
  files: z.array(z.string()),
  status: taskStatusSchema,
  error: z.string().exactOptional(),
  ended: z.enum(INCOMPLETE_ENDINGS).exactOptional(),
  findings: z.int().nonnegative(),
  durationMs: z.number(),
  usage: usageSchema,
  // Taken from this earlier run (--resume): usage is what that run paid.
  reusedFrom: z.string().exactOptional(),
});

export const skippedCellSchema = z.strictObject({
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
  temperature: z.number().exactOptional(),
  seed: z.int().exactOptional(),
  notApplied: z.array(z.enum(["temperature", "seed"])).exactOptional(),
});

const agentProvenanceSchema = z.strictObject({
  tier: z.enum(MODEL_TIERS),
  models: z.array(z.string()).exactOptional(),
  effort: z.enum(EFFORT_LEVELS).exactOptional(),
  applied: z.boolean().exactOptional(),
  notApplied: z.array(z.enum(["temperature", "seed"])).exactOptional(),
});

const provenanceSchema = z.strictObject({
  ocraVersion: z.string(),
  promptHash: z.string(),
  configHash: z.string(),
  sampling: samplingSchema,
  agents: z.record(z.string(), agentProvenanceSchema).exactOptional(),
  rules: z
    .array(
      z.strictObject({
        path: z.array(z.string()),
        rule: z.string(),
        source: z.enum(["repository", "shared", "account", "plugin"]).exactOptional(),
      }),
    )
    .exactOptional(),
  accountSettings: z.strictObject({ version: z.string().nullable() }).exactOptional(),
});

export const reportOutputSchema = z.strictObject({
  version: z.literal(REPORT_VERSION),
  runId: z.string().exactOptional(),
  changeRequest: changeRequestSchema,
  tier: riskTierSchema,
  verdict: verdictSchema,
  summary: z.string(),
  scope: scopeSchema.exactOptional(),
  coverage: z.array(coverageEntrySchema),
  findings: z.array(outputFindingSchema),
  unverifiedCriticals: z.int().nonnegative(),
  refuted: z.array(refutedFindingSchema),
  remembered: z.array(
    memoryEntrySchema.extend({ source: z.enum(["repository", "account"]).exactOptional() }),
  ),
  judgement: judgeDecisionsSchema.exactOptional(),
  rereview: z
    .strictObject({
      fixed: priorList,
      notReproduced: priorList,
      notRechecked: priorList,
      unchanged: priorList,
      dismissed: priorList,
    })
    .exactOptional(),
  tasks: z.array(taskOutcomeSchema),
  skipped: z.array(skippedCellSchema),
  bundles: z.array(z.strictObject({ label: z.string(), files: z.array(z.string()) })),
  anchoring: anchoringSummarySchema.exactOptional(),
  spendLimit: z
    .strictObject({ usd: z.number(), reached: z.enum(["review", "total"]).exactOptional() })
    .exactOptional(),
  provenance: provenanceSchema.exactOptional(),
  usage: usageSchema,
  warnings: z.array(z.string()),
});

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
