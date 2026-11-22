import { z } from "zod";
import { usageSchema } from "./events.js";
import { MAX_FIELD } from "./limits.js";

/** What `ocra generate` writes on a pull or merge request (ADR-0051). */
export const GENERATE_KINDS = ["tests", "docstrings"] as const;
export type GenerateKind = (typeof GENERATE_KINDS)[number];

/**
 * How a run of `ocra generate` ended: `committed` one commit on the branch;
 * `dry_run` edits made and printed, nothing committed; `nothing` no file to
 * write for; `head_moved` the branch moved after ocra read it;
 * `not_writable` the token cannot write to the branch (a fork's, a
 * protected one).
 */
export const GENERATE_OUTCOMES = [
  "committed",
  "dry_run",
  "nothing",
  "head_moved",
  "not_writable",
] as const;
export type GenerateOutcome = (typeof GENERATE_OUTCOMES)[number];

/** The most files one result names; the CLI writes for fewer. */
export const MAX_GENERATED_FILES = 20;

const commitId = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/**
 * The one line `ocra generate --json` prints. `files`: the paths the edits
 * touch, committed or not; `reason`: why nothing was committed, null when a
 * commit was made or on a dry run.
 */
export const generateResultSchema = z.object({
  kind: z.enum(GENERATE_KINDS),
  outcome: z.enum(GENERATE_OUTCOMES),
  headSha: commitId,
  commitSha: commitId.nullable(),
  files: z.array(z.string().min(1).max(MAX_FIELD)).max(MAX_GENERATED_FILES),
  usage: usageSchema,
  reason: z.string().max(MAX_FIELD).nullable(),
});
export type GenerateResult = z.infer<typeof generateResultSchema>;
