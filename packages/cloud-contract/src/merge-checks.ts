import { z } from "zod";
import { MAX_FIELD } from "./limits.js";

// Pre-merge checks in plain words (ADR-0054): the team's instructions, which
// a review of a pull or merge request judges against the change, and each
// one's outcome as the review uploads it.

/** At most this many checks in a review's configuration and in an upload. */
export const MAX_MERGE_CHECKS = 20;
/** Characters of one check's instruction. */
export const MAX_MERGE_CHECK_INSTRUCTION = 500;
/** A check's id; ocra Cloud makes a new one when the instruction changes. */
export const MERGE_CHECK_ID = /^[\w.:-]{1,64}$/;

/** A check as the configuration's `mergeChecks` lists it. */
export const mergeCheckSchema = z.strictObject({
  id: z.string().regex(MERGE_CHECK_ID),
  instruction: z.string().trim().min(1).max(MAX_MERGE_CHECK_INSTRUCTION),
});
export type MergeCheck = z.output<typeof mergeCheckSchema>;

/** `inconclusive` when the change does not show either way, or the check was not judged. */
export const MERGE_CHECK_OUTCOMES = ["passed", "failed", "inconclusive"] as const;
export type MergeCheckOutcome = (typeof MERGE_CHECK_OUTCOMES)[number];

/**
 * A check's outcome in an upload: always with a pull or merge request's
 * review, its reason only with the findings, redacted the same way.
 */
export const sharedMergeCheckSchema = z.object({
  id: z.string().regex(MERGE_CHECK_ID),
  outcome: z.enum(MERGE_CHECK_OUTCOMES),
  reason: z.string().max(MAX_FIELD).optional().catch(undefined),
  redacted: z.literal(true).optional().catch(undefined),
  truncated: z.literal(true).optional().catch(undefined),
});
export type SharedMergeCheck = z.input<typeof sharedMergeCheckSchema>;
