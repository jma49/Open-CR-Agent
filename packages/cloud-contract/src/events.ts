import { z } from "zod";
import { MAX_FIELD } from "./limits.js";
import { FINGERPRINT } from "./upload.js";
import {
  REVIEWER_ID,
  riskTierSchema,
  severitySchema,
  verdictSchema,
  verificationSchema,
} from "./vocabulary.js";

// The live events of one review, as `ocra serve` streams them (SSE, one
// event per `data:` line, `seq` as the SSE id) and as ocra Cloud stores and
// relays them. A new kind or field keeps the version: a reader skips a kind
// it does not know (readReviewEvent). A changed meaning raises it.

export const REVIEW_EVENT_VERSION = 1;

/** The stages of a run, in order. */
export const STAGES = [
  "select",
  "bundle",
  "plan",
  "review",
  "anchor",
  "filter",
  "verify",
  "judge",
] as const;
export const stageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof stageSchema>;

/** A file's last state in a run, as the report's coverage records it. */
export const FILE_STATUSES = [
  "reviewed",
  "unchanged",
  "incomplete",
  "failed",
  "unreviewed",
  "excluded",
] as const;
export const fileStatusSchema = z.enum(FILE_STATUSES);

export const TASK_STATUSES = ["completed", "failed", "timed_out", "cancelled"] as const;

/** Why a run ended without a verdict. */
export const FAILURE_REASONS = ["cancelled", "budget", "error"] as const;

const count = z.number().int().min(0).max(1e12);
const path = z.string().min(1).max(1024);
const text = z.string().max(MAX_FIELD);
const id = z.string().regex(/^[\w.:-]{1,128}$/);
const line = z.number().int().positive().lt(10_000_000);

/**
 * A finding as a live view shows it. The same id comes again when Verify or
 * the judge changes it, and replaces the earlier one; `dropped` says the
 * judge left it out of the report.
 */
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
});
export type LiveFinding = z.infer<typeof liveFindingSchema>;

/** Tokens and dollars spent so far in the run, every model call included. */
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
      // On select: what the run reviews and what it left out.
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

/** What every event carries, whatever its kind. */
export const reviewEventEnvelopeSchema = z.object({
  version: z.literal(REVIEW_EVENT_VERSION),
  runId: z.string().regex(/^[\w.-]{1,64}$/),
  // From 1, one more per event of the run: a gap means a lost event.
  seq: z.number().int().positive(),
  at: z.iso.datetime(),
});

export const reviewEventSchema = z.intersection(
  reviewEventEnvelopeSchema,
  z.discriminatedUnion("kind", kinds),
);
export type ReviewEvent = z.infer<typeof reviewEventSchema>;
export type ReviewEventKind = ReviewEvent["kind"];

/** The kinds that end a run; each run ends with exactly one. */
export const ENDING_KINDS = ["finished", "failed"] as const satisfies readonly ReviewEventKind[];

const knownKinds = new Set<string>(kinds.map((k) => k.shape.kind.value));

/**
 * Reads one event as a client should: an event of a kind this version does
 * not know is skipped (`undefined`), a known kind that does not fit its
 * shape is an error.
 */
export function readReviewEvent(value: unknown): ReviewEvent | undefined {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (typeof kind === "string" && !knownKinds.has(kind)) {
    reviewEventEnvelopeSchema.parse(value);
    return undefined;
  }
  return reviewEventSchema.parse(value);
}
