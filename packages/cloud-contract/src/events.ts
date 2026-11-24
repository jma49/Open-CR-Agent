import { z } from "zod";
import { MAX_FIELD } from "./limits.js";
import {
  FINGERPRINT,
  REVIEWER_ID,
  riskTierSchema,
  severitySchema,
  verdictSchema,
  verificationSchema,
} from "./vocabulary.js";

// What `ocra serve` streams and ocra Cloud relays. A new kind or field keeps
// the version, since readers skip unknown kinds; a changed meaning raises it.

export const REVIEW_EVENT_VERSION = 1;

export const STAGES = [
  "select",
  "bundle",
  "plan",
  "review",
  "filter",
  "verify",
  "judge",
  "fix",
] as const;
export const stageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof stageSchema>;

export const FILE_STATUSES = [
  "reviewed",
  "unchanged",
  "incomplete",
  "failed",
  "unreviewed",
  "excluded",
] as const;
export const fileStatusSchema = z.enum(FILE_STATUSES);
export type FileStatus = z.infer<typeof fileStatusSchema>;

export const TASK_STATUSES = ["completed", "failed", "timed_out", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const FAILURE_REASONS = ["cancelled", "budget", "error"] as const;

const count = z.number().int().min(0).max(1e12);
const path = z.string().min(1).max(1024);
const text = z.string().max(MAX_FIELD);
const id = z.string().regex(/^[\w.:-]{1,128}$/);
const line = z.number().int().positive().lt(10_000_000);

// A finding sent again under the same id (after Verify or the judge)
// replaces the earlier one. settled: the run's report carries it as it is
// here (ADR-0074), so it can be shown as a result before the run ends.
export const liveFindingSchema = z.object({
  id,
  fingerprint: z.string().regex(FINGERPRINT),
  reviewer: z.string().regex(REVIEWER_ID),
  severity: severitySchema,
  category: text.optional(),
  file: path,
  lineStart: line.optional(),
  lineEnd: line.optional(),
  title: text,
  body: text,
  suggestion: text.optional(),
  verification: verificationSchema.optional(),
  preExisting: z.literal(true).optional(),
  dropped: z.literal(true).optional(),
  settled: z.literal(true).optional(),
});
export type LiveFinding = z.infer<typeof liveFindingSchema>;

// Cumulative for the run.
export const usageSchema = z.object({
  inputTokens: count,
  cachedTokens: count,
  outputTokens: count,
  reasoningTokens: count,
  costUsd: z.number().min(0).lt(1e6),
});

const kinds = [
  z.object({
    kind: z.literal("started"),
    data: z.object({ target: text, tier: riskTierSchema.optional() }),
  }),
  z.object({
    kind: z.literal("stage"),
    data: z.object({
      stage: stageSchema,
      files: z.array(path).optional(),
      excluded: z.array(path).optional(),
    }),
  }),
  z.object({
    kind: z.literal("task.started"),
    data: z.object({ taskId: id, reviewer: z.string().regex(REVIEWER_ID), files: z.array(path) }),
  }),
  z.object({
    kind: z.literal("task.finished"),
    data: z.object({ taskId: id, status: z.enum(TASK_STATUSES), steps: count.optional() }),
  }),
  z.object({
    kind: z.literal("file.finished"),
    data: z.object({ path, status: fileStatusSchema, error: text.optional() }),
  }),
  z.object({ kind: z.literal("finding"), data: liveFindingSchema }),
  z.object({ kind: z.literal("warning"), data: z.object({ message: text }) }),
  z.object({ kind: z.literal("usage"), data: usageSchema }),
  z.object({
    kind: z.literal("finished"),
    data: z.object({ verdict: verdictSchema, complete: z.boolean(), usage: usageSchema }),
  }),
  z.object({
    kind: z.literal("failed"),
    data: z.object({ reason: z.enum(FAILURE_REASONS), message: text.optional() }),
  }),
] as const;

export const reviewEventEnvelopeSchema = z.object({
  version: z.literal(REVIEW_EVENT_VERSION),
  runId: z.string().regex(/^[\w.-]{1,64}$/),
  // From 1 without gaps, so a reader can tell it lost one.
  seq: z.number().int().positive(),
  at: z.iso.datetime(),
});

export const reviewEventSchema = z.intersection(
  reviewEventEnvelopeSchema,
  z.discriminatedUnion("kind", kinds),
);
export type ReviewEvent = z.infer<typeof reviewEventSchema>;
export type ReviewEventKind = ReviewEvent["kind"];

// Each run ends with exactly one.
export const ENDING_KINDS = ["finished", "failed"] as const satisfies readonly ReviewEventKind[];

const knownKinds = new Set<string>(kinds.map((k) => k.shape.kind.value));

// Undefined for a kind this version does not know; throws on a known kind
// that does not fit.
export function readReviewEvent(value: unknown): ReviewEvent | undefined {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (typeof kind === "string" && !knownKinds.has(kind)) {
    reviewEventEnvelopeSchema.parse(value);
    return undefined;
  }
  return reviewEventSchema.parse(value);
}
