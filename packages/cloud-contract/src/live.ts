import { z } from "zod";
import { reviewEventEnvelopeSchema } from "./events.js";
import { REPOSITORY_URL } from "./repository.js";
import { REPO_HASH, reviewSourceSchema } from "./vocabulary.js";

// A review's events relayed to ocra Cloud while it runs, so others can watch
// it (ADR-0056). Only an account that shares findings relays: the events
// carry file paths and finding text.

export const LIVE_EVENTS_PATH = "/api/live";
/** Events in one batch; the CLI sends what it has about once a second. */
export const MAX_LIVE_BATCH = 100;
/** One batch's largest body, in bytes. */
export const MAX_LIVE_BATCH_BYTES = 524_288;
/** Events ocra Cloud keeps of one run; past it the run is no longer relayed. */
export const MAX_LIVE_EVENTS = 5_000;

export const liveRunSchema = z.object({
  repoHash: z.string().regex(REPO_HASH),
  source: reviewSourceSchema,
  pullRequest: z
    .object({
      repository: z.string().regex(REPOSITORY_URL),
      number: z.number().int().positive().lt(1e9),
    })
    .optional(),
});
export type LiveRun = z.infer<typeof liveRunSchema>;

// Every batch names its run, so the first one that arrives can open it. The
// server reads each event with readReviewEvent, which skips kinds it does
// not know yet.
export const liveBatchSchema = z
  .object({
    run: liveRunSchema,
    events: z.array(reviewEventEnvelopeSchema.loose()).min(1).max(MAX_LIVE_BATCH),
  })
  .refine((b) => b.events.every((e) => e.runId === b.events[0]?.runId), "events of one run");
export type LiveBatch = z.input<typeof liveBatchSchema>;

/** Where the run can be watched; absent once the server stopped taking its events. */
export const liveAnswerSchema = z.object({
  watch: z
    .url({ protocol: /^https?$/ })
    .optional()
    .catch(undefined),
});
