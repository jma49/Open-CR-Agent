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
 * What failed when the reason is `failed`, short enough to show and never an
 * endpoint's own words: `timeout` the call's deadline passed; `quota` every
 * model is out of quota or rate limited; `refused` the endpoint refused the
 * request (the key, the model's name, a parameter); `unavailable` it failed
 * or could not be reached; `invalid_output` it answered, and not in the form
 * asked for. The engine's own list is `CALL_FAILURES` in
 * `@open-cr-agent/core`; a test keeps this one equal to it.
 */
export const FIX_FAILURE_CAUSES = [
  "timeout",
  "quota",
  "refused",
  "unavailable",
  "invalid_output",
  "unknown",
] as const;
export type FixFailureCause = (typeof FIX_FAILURE_CAUSES)[number];

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
 * other outcome but `head_moved`; `cause`: set only for the reason `failed`,
 * and null in the answer of a version that gave none.
 */
export const fixResultSchema = z
  .object({
    fingerprint: z.string().regex(FINGERPRINT),
    headSha: commitId,
    outcome: z.enum(FIX_OUTCOMES),
    fix: sharedFixSchema.nullable(),
    reason: z.enum(FIX_REASONS).nullable(),
    cause: z.enum(FIX_FAILURE_CAUSES).nullable().default(null),
    usage: usageSchema,
  })
  .refine((r) => (r.outcome === "proposed") === (r.fix !== null), {
    message: "a fix comes with the proposed outcome, and only with it",
  })
  .refine((r) => (r.outcome === "proposed" || r.outcome === "head_moved") === (r.reason === null), {
    message: "every outcome but proposed and head_moved gives its reason",
  })
  .refine((r) => r.cause === null || r.reason === "failed", {
    message: "a cause comes only with the failed reason",
  });
export type FixResult = z.infer<typeof fixResultSchema>;
