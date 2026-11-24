import { z } from "zod";
import { stageSchema, TASK_STATUSES } from "./events.js";
import { FINGERPRINT, REVIEWER_ID, severitySchema } from "./vocabulary.js";

// How a review came to its findings, laid out in time (ADR-0081), as an
// upload that shares the findings carries it: paths, counts, timings, spend,
// titles and the verifier's and judge's reasons, redacted like the
// findings; never code, a prompt, an answer or a searched literal. One that
// does not fit reads as absent.

/** Tasks a shared trace keeps, and attempts of each. */
export const MAX_TRACE_TASKS = 500;
export const MAX_TRACE_ATTEMPTS = 8;
/** Plain model calls a shared trace keeps. */
export const MAX_TRACE_CALLS = 500;
/** Findings, reported or dropped, a shared trace keeps. */
export const MAX_TRACE_FINDINGS = 500;
/** Paths kept of one task's files and of what one attempt read. */
export const MAX_TRACE_PATHS = 200;
/** Characters kept of a trace's title or reason. */
export const MAX_TRACE_TEXT = 1_000;
/** One shared trace as JSON, in bytes. */
export const MAX_TRACE_BYTES = 786_432;

export const FINDING_FATES = [
  "kept",
  "outside_review",
  "refuted",
  "merged",
  "dropped",
  "filtered",
] as const;
const findingFateSchema = z.enum(FINDING_FATES);
export type FindingFate = (typeof FINDING_FATES)[number];

export const ATTEMPT_ENDINGS = [
  "done",
  "step_cap",
  "context_window",
  "stopped_early",
  "error",
] as const;

// A week: no review runs longer.
const ms = z.number().int().min(0).lt(604_800_000);
const count = z.number().int().min(0).max(1e12);
const path = z.string().min(1).max(1024);
const text = z.string().max(MAX_TRACE_TEXT);
const agent = z.string().regex(/^[\w.:@-]{1,100}$/);
const model = z.string().regex(/^[\w.:/@+-]{1,200}$/);
const fingerprint = z.string().regex(FINGERPRINT);
// A task id is its reviewer's id and a number (matrix).
const taskId = z.string().regex(/^[\w.:@-]{1,128}$/);

const traceUsageSchema = z.object({
  inputTokens: count,
  cachedTokens: count,
  outputTokens: count,
  reasoningTokens: count,
  costUsd: z.number().min(0).lt(1e6),
});

const traceAttemptSchema = z.object({
  model,
  startMs: ms,
  ms,
  steps: count,
  tools: z.record(z.string().regex(/^[\w.-]{1,64}$/), count),
  ending: z.enum(ATTEMPT_ENDINGS),
  read: z.array(path).max(MAX_TRACE_PATHS),
  searches: count,
  usage: traceUsageSchema,
});

const traceTaskSchema = z.object({
  id: taskId,
  reviewer: z.string().regex(REVIEWER_ID),
  bundle: text,
  files: z.array(path).max(MAX_TRACE_PATHS),
  status: z.enum(TASK_STATUSES),
  // Absent for a task taken from an earlier run (reused), which was not timed.
  startMs: ms.optional(),
  ms: ms.optional(),
  reused: z.literal(true).optional(),
  usage: traceUsageSchema,
  attempts: z.array(traceAttemptSchema).max(MAX_TRACE_ATTEMPTS),
});

const traceCallSchema = z.object({
  agent,
  stage: stageSchema.optional(),
  model: model.optional(),
  startMs: ms,
  ms,
  usage: traceUsageSchema,
  failed: z.literal(true).optional(),
});

const traceFindingSchema = z.object({
  fingerprint: fingerprint.optional(),
  taskId: taskId.optional(),
  reviewer: z.string().regex(REVIEWER_ID).optional(),
  severity: severitySchema.optional(),
  file: path,
  line: z.number().int().positive().lt(10_000_000).optional(),
  title: text,
  atMs: ms.optional(),
  fate: findingFateSchema,
  reason: text.optional(),
  mergedInto: fingerprint.optional(),
  recalibrated: z.object({ from: severitySchema, to: severitySchema, reason: text }).optional(),
});

export const sharedTraceSchema = z.object({
  startedAt: z.iso.datetime(),
  ms,
  stages: z.array(z.object({ stage: stageSchema, startMs: ms, ms })).max(64),
  tasks: z.array(traceTaskSchema).max(MAX_TRACE_TASKS),
  calls: z.array(traceCallSchema).max(MAX_TRACE_CALLS),
  findings: z.array(traceFindingSchema).max(MAX_TRACE_FINDINGS),
  // A title, reason or path had a secret replaced, or the trace was cut to
  // its bounds.
  redacted: z.literal(true).optional(),
  truncated: z.literal(true).optional(),
});
export type SharedTrace = z.input<typeof sharedTraceSchema>;
