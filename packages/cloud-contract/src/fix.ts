import { z } from "zod";
import { usageSchema } from "./events.js";
import { commitId } from "./generate.js";
import { FINGERPRINT, sharedFixSchema } from "./upload.js";

/**
 * Why a fix the fixer was asked for was not kept (ADR-0058): the reasons a
 * review's report gives under `fixes.rejected`. The engine's own list is
 * `FIX_REJECTIONS` in `@open-cr-agent/core`; this one is kept equal to it by
 * a test, since this package depends on nothing but Zod.
 */
export const FIX_REJECTIONS = [
  "declined",
  "failed",
  "stale",
  "unchanged",
  "unsafe",
  "too_large",
  "no_parser",
  "syntax",
] as const;

/**
 * Why `ocra fix` wrote no fix (ADR-0077): a rejection, or `not_candidate`,
 * a finding a fix is never asked for (not anchored to the change's lines,
 * ambiguous, low confidence, or over 30 lines).
 */
export const FIX_REASONS = [...FIX_REJECTIONS, "not_candidate"] as const;
export type FixReason = (typeof FIX_REASONS)[number];

/**
 * How a run of `ocra fix` ended: `proposed` a fix that passed every check;
 * `rejected` the fixer answered and a check refused it, or the call failed;
 * `not_fixable` the finding is not one a fix is asked for, the fixer
 * declined, or its file's language has no parser; `stale` the finding's
 * code is not at the head; `head_moved` the change's head is not `--head`.
 */
export const FIX_OUTCOMES = ["proposed", "rejected", "not_fixable", "stale", "head_moved"] as const;
export type FixOutcome = (typeof FIX_OUTCOMES)[number];

/**
 * The one line `ocra fix --json` prints. `fix`: the replacement of lines of
 * the file at `headSha`, set only when `proposed`; `reason`: set for every
 * other outcome but `head_moved`.
 */
export const fixResultSchema = z
  .object({
    fingerprint: z.string().regex(FINGERPRINT),
    headSha: commitId,
    outcome: z.enum(FIX_OUTCOMES),
    fix: sharedFixSchema.nullable(),
    reason: z.enum(FIX_REASONS).nullable(),
    usage: usageSchema,
  })
  .refine((r) => (r.outcome === "proposed") === (r.fix !== null), {
    message: "a fix comes with the proposed outcome, and only with it",
  })
  .refine((r) => (r.outcome === "proposed" || r.outcome === "head_moved") === (r.reason === null), {
    message: "every outcome but proposed and head_moved gives its reason",
  });
export type FixResult = z.infer<typeof fixResultSchema>;
