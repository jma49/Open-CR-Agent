import { z } from "zod";

// The findings an account remembers per repository (ADR-0028, 4): set from
// the web, applied by a signed-in review with .ocra/memory.json's.

/** POST /api/memory: remember an uploaded finding, with why. */
export const rememberRequestSchema = z.object({
  findingId: z.string(),
  reason: z
    .string()
    .transform((r) => r.trim())
    .pipe(z.string().min(1).max(500)),
});
export type RememberRequest = z.input<typeof rememberRequestSchema>;

/** An entry as GET /api/memory lists it. */
export const memoryEntrySchema = z.object({
  id: z.string(),
  repoHash: z.string(),
  // The hash's first 8 characters, for the web.
  repo: z.string(),
  fingerprint: z.string(),
  file: z.string().nullable(),
  title: z.string().nullable(),
  reason: z.string(),
  // ISO 8601.
  createdAt: z.string(),
});
export type MemoryEntry = z.input<typeof memoryEntrySchema>;

/**
 * GET /api/memory[?repo=<hash>]. A client reads each entry on its own with
 * the fields it needs, and skips one it cannot use.
 */
export const memoryAnswerSchema = z.object({ entries: z.array(z.unknown()) });
