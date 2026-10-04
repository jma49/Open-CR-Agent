import { z } from "zod";
import {
  REPO_HASH,
  REVIEWER_ID,
  reviewSourceSchema,
  riskTierSchema,
  severitySchema,
  verdictSchema,
  verificationSchema,
} from "./vocabulary.js";

// POST /api/reviews: what a signed-in CLI sends after a review (ADR-0024,
// ADR-0028), and what ocra Cloud answers.
//
// Each schema's input type is what a client sends; its output is what the
// server keeps. Past the identifying fields, a value the server cannot use
// becomes its default instead of refusing the upload, so a newer client (a
// new tier, say) still has its counts kept.

const count = z.number().int().min(0).max(1e12).catch(0);
const costUsd = z.number().min(0).lt(1e6).catch(0);

export const severityCountsSchema = z
  .object({ critical: count, warning: count, suggestion: count })
  .catch({ critical: 0, warning: 0, suggestion: 0 });

export const reviewerCountsSchema = z.object({
  tasks: count,
  failedTasks: count,
  findings: severityCountsSchema,
  costUsd,
  fixed: count,
  dismissed: count,
});
export type ReviewerCounts = z.input<typeof reviewerCountsSchema>;

/** A finding's stable id across runs. */
export const FINGERPRINT = /^[\w:.-]{4,128}$/;
const line = z.number().int().min(0).lt(10_000_000).nullable().catch(null);

/**
 * A finding as the CLI shares it when the account shares findings
 * (ADR-0028, 2): already redacted and bounded (redact, MAX_FIELD), which
 * the server does again. One that fails is left out on its own.
 */
export const sharedFindingSchema = z.object({
  fingerprint: z.string().regex(FINGERPRINT),
  reviewer: z.string().regex(REVIEWER_ID),
  severity: severitySchema,
  category: z.string().nullable().catch(null),
  verification: verificationSchema.nullable().catch(null),
  file: z.string().min(1).max(1024),
  lineStart: line,
  lineEnd: line,
  title: z.string(),
  body: z.string(),
  suggestion: z.string().nullable().catch(null),
  code: z.string().nullable().catch(null),
  // Set when the CLI replaced a secret-looking string or cut a long field.
  redacted: z.literal(true).optional().catch(undefined),
  truncated: z.literal(true).optional().catch(undefined),
});
export type SharedFinding = z.input<typeof sharedFindingSchema>;

/**
 * The review's counts, and the shared findings in `findingList`. A finding
 * or a reviewer's counts that do not fit read as null; the server keeps
 * the first MAX_FINDINGS findings and the first MAX_REVIEWERS reviewers
 * under a REVIEWER_ID, and answers what it left out as `dropped`.
 */
export const reviewUploadSchema = z.object({
  runId: z.string().regex(/^[\w.-]{1,64}$/),
  repoHash: z.string().regex(REPO_HASH),
  source: reviewSourceSchema,
  tier: riskTierSchema.nullable().catch(null),
  verdict: verdictSchema.nullable().catch(null),
  // As the exit code reads it: incomplete when files went unreviewed or a
  // critical finding could not be verified.
  complete: z.boolean().catch(true),
  findings: severityCountsSchema,
  files: z.object({ reviewed: count, notReviewed: count }).catch({ reviewed: 0, notReviewed: 0 }),
  tasks: z.object({ completed: count, failed: count }).catch({ completed: 0, failed: 0 }),
  usage: z
    .object({ inputTokens: count, outputTokens: count, costUsd })
    .catch({ inputTokens: 0, outputTokens: 0, costUsd: 0 }),
  durationMs: count,
  ocraVersion: z
    .string()
    .regex(/^[\w.+-]{1,32}$/)
    .nullable()
    .catch(null),
  // Added by ADR-0028; optional so a server reading older uploads still can.
  reviewers: z
    .record(z.string(), reviewerCountsSchema.nullable().catch(null))
    .optional()
    .catch(undefined),
  verification: z
    .object({ confirmed: count, uncertain: count, unchecked: count })
    .partial()
    .optional()
    .catch(undefined),
  outcomes: z.object({ fixed: count, dismissed: count }).optional().catch(undefined),
  findingList: z.array(sharedFindingSchema.nullable().catch(null)).optional().catch(undefined),
});
export type ReviewUpload = z.input<typeof reviewUploadSchema>;

/** What the server took: how many findings it kept, and what it left out. */
export const uploadAnswerSchema = z.object({
  id: z.string().optional().catch(undefined),
  // A retry of a run already uploaded; nothing new was kept.
  duplicate: z.literal(true).optional().catch(undefined),
  findings: z.number().int().positive().optional().catch(undefined),
  truncated: z.literal(true).optional().catch(undefined),
  dropped: z
    .object({ findings: count.optional(), reviewers: count.optional() })
    .optional()
    .catch(undefined),
  // The account holds as many findings as it may; the counts were kept.
  findingsSkipped: z.literal("account_limit").optional().catch(undefined),
});
export type UploadAnswer = z.input<typeof uploadAnswerSchema>;
