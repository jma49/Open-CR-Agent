import { z } from "zod";
import { usageSchema } from "./events.js";
import { FIX_FAILURE_CAUSES, FIX_REJECTIONS } from "./fix.js";
import { commitId } from "./generate.js";
import { MAX_FIELD, MAX_FINDINGS } from "./limits.js";
import { FINGERPRINT, sharedFindingSchema } from "./upload.js";

/**
 * How far a round of `ocra mend` goes (ADR-0078): `propose` ends with its
 * checked edits for a person to commit; `commit` writes them to the change
 * request's branch.
 */
export const MEND_LEVELS = ["propose", "commit"] as const;
export type MendLevel = (typeof MEND_LEVELS)[number];

/**
 * How a round ended: `committed` one commit on the branch; `proposed` edits
 * made and printed, nothing committed; `nothing` no finding got an edit;
 * `stopped` a cap of the loop was reached before the round; `head_moved`
 * the head is not `--head`, or moved while the round worked;
 * `not_writable` the token cannot write to the branch; `waiting` the head's
 * checks have not finished and nothing else was open: no round was counted,
 * ask again when they have.
 */
export const MEND_OUTCOMES = [
  "committed",
  "proposed",
  "nothing",
  "stopped",
  "head_moved",
  "not_writable",
  "waiting",
] as const;
export type MendOutcome = (typeof MEND_OUTCOMES)[number];

/** The cap that stopped the loop: its rounds, or its spend. */
export const MEND_STOPS = ["rounds", "spend"] as const;

/**
 * What a round did with one finding or failed check: `fixed` its edit is in the round's
 * commit; `proposed` its edit is in what the round proposes; `rejected` no
 * edit of this round passed, another round may try; `deferred` not tried,
 * or tried and not written, and no attempt counted; `needs_human` closed
 * for a person; `gone` closed because its code is not at the head.
 */
export const MEND_ITEM_OUTCOMES = [
  "fixed",
  "proposed",
  "rejected",
  "deferred",
  "needs_human",
  "gone",
] as const;
export type MendItemOutcome = (typeof MEND_ITEM_OUTCOMES)[number];

/**
 * Why a finding got no edit, or its edit was not written: the fixer's
 * rejections, the gate's (`out_of_scope`, `protected`, `tamper`), the
 * verifier's (`unresolved`, `unsure`, `unchecked`), the round's (`overlap`
 * with an earlier edit, `no_room` under its caps, `attempts` used up) and
 * the write's; `conflicts`: the item waits because the change's merge
 * conflicts are worked on first, or are not all resolved. The engine's own list is `MEND_ITEM_REASONS` in
 * `@open-cr-agent/core`; a test keeps this one equal to it.
 */
export const MEND_ITEM_REASONS = [
  ...FIX_REJECTIONS,
  "not_candidate",
  "out_of_scope",
  "protected",
  "tamper",
  "unresolved",
  "unsure",
  "unchecked",
  "overlap",
  "no_room",
  "attempts",
  "conflicts",
  "head_moved",
  "not_writable",
] as const;
export type MendItemReason = (typeof MEND_ITEM_REASONS)[number];

/** The most findings one round is given; it works on fewer. */
export const MAX_MEND_FINDINGS = MAX_FINDINGS;

/** The most failed checks one round works on, with `--checks`. */
export const MAX_MEND_CHECKS = 3;

/** The most conflicted files one round names, with `--conflicts`; it resolves fewer. */
export const MAX_MEND_CONFLICTS = 50;

/** The most characters of a conflicted file a round resolves. */
export const MAX_RESOLVED_CHARS = 400_000;

/** What `ocra mend --findings` reads: the accepted findings, the most important first. */
export const mendFindingsSchema = z.array(sharedFindingSchema).max(MAX_MEND_FINDINGS);

/**
 * What the loop remembers of a change request between rounds. A round
 * prints the next one; the scheduler keeps it and passes it back with
 * `--state`.
 */
export const mendStateSchema = z.object({
  rounds: z.number().int().min(0),
  costUsd: z.number().min(0).lt(1e6),
  items: z.record(
    z.string().regex(FINGERPRINT),
    z.object({
      attempts: z.number().int().min(0),
      closed: z.enum(["needs_human", "gone"]).optional(),
    }),
  ),
});
export type MendState = z.infer<typeof mendStateSchema>;

const line = z.number().int().positive();

/** Whole lines of a file at the round's head and what replaces them. */
const mendEditSchema = z
  .object({
    path: z.string().min(1).max(1024),
    startLine: line,
    endLine: line,
    replacement: z.string().max(MAX_FIELD),
  })
  .refine((e) => e.endLine >= e.startLine, { message: "an edit ends at or after its first line" });

/** The most conflicted regions of one file a round answers (the engine's `CONFLICT_LIMITS.regions`). */
const MAX_MEND_REGIONS = 8;

/**
 * One conflicted region of a file as a round answered it: `line` is where
 * `resolved` starts in the file's resolved content, `ours` the change
 * request's lines and `theirs` the base branch's, each joined by newlines.
 */
const mendRegionSchema = z.object({
  line,
  ours: z.string().max(MAX_RESOLVED_CHARS),
  theirs: z.string().max(MAX_RESOLVED_CHARS),
  resolved: z.string().max(MAX_RESOLVED_CHARS),
});

const itemSchema = z
  .object({
    // A finding's fingerprint, or the id the round gives a failed check: the
    // same while the check fails the same way.
    fingerprint: z.string().regex(FINGERPRINT),
    // The failed check's name, for an item that is one; null for a finding.
    check: z.string().max(MAX_FIELD).nullable().default(null),
    // The conflicted file's path, for an item that is a merge conflict.
    conflict: z.string().max(1024).nullable().default(null),
    // That file's whole content with its conflicts resolved, for a proposed one.
    resolved: z.string().max(MAX_RESOLVED_CHARS).nullable().default(null),
    // That file's conflicted regions and what each was resolved to, for a
    // proposed one; empty otherwise, and in the answer of a version that gave none.
    regions: z.array(mendRegionSchema).max(MAX_MEND_REGIONS).default([]),
    outcome: z.enum(MEND_ITEM_OUTCOMES),
    reason: z.enum(MEND_ITEM_REASONS).nullable(),
    // What failed, for the reason `failed`; null otherwise, and in the answer of a version that gave none.
    cause: z.enum(FIX_FAILURE_CAUSES).nullable().default(null),
    edits: z.array(mendEditSchema),
  })
  .refine(
    (i) =>
      i.conflict === null
        ? (i.outcome === "fixed" || i.outcome === "proposed") === i.edits.length > 0
        : i.edits.length === 0,
    {
      message:
        "edits come with a fixed or proposed finding or check, only with them, and never with a conflict",
    },
  )
  .refine((i) => (i.resolved !== null) === (i.conflict !== null && i.outcome === "proposed"), {
    message: "a resolved file comes with a proposed conflict, and only with it",
  })
  .refine((i) => i.regions.length === 0 || i.resolved !== null, {
    message: "regions come only with a resolved file",
  })
  .refine((i) => i.cause === null || i.reason === "failed", {
    message: "a cause comes only with the failed reason",
  });

/**
 * The one line `ocra mend --json` prints. `stopped`: set only for the
 * `stopped` outcome; `commitSha`: set only for `committed`; `state`: what
 * to pass to the next round.
 */
export const mendResultSchema = z
  .object({
    headSha: commitId,
    outcome: z.enum(MEND_OUTCOMES),
    stopped: z.enum(MEND_STOPS).nullable(),
    commitSha: commitId.nullable(),
    // The base branch's commit a round over merge conflicts merged, or
    // proposes to merge; null for any other round.
    mergeParent: commitId.nullable().default(null),
    items: z.array(itemSchema).max(MAX_MEND_FINDINGS + MAX_MEND_CHECKS + MAX_MEND_CONFLICTS),
    state: mendStateSchema,
    usage: usageSchema,
  })
  .refine((r) => (r.outcome === "stopped") === (r.stopped !== null), {
    message: "a stop comes with the stopped outcome, and only with it",
  })
  .refine((r) => (r.outcome === "committed") === (r.commitSha !== null), {
    message: "a commit comes with the committed outcome, and only with it",
  });
export type MendResult = z.infer<typeof mendResultSchema>;
