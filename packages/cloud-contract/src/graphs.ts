import { z } from "zod";

// The code graphs a self-hosted server keeps (ADR-0041): it builds one per
// push of a repository's default branch, and `ocra graph --cloud` starts
// from the newest instead of parsing every file again.

export const CODE_PLATFORMS = ["github", "gitlab"] as const;
export type CodePlatform = (typeof CODE_PLATFORMS)[number];

export const GRAPH_BUILD_STATES = ["queued", "running", "done", "failed", "superseded"] as const;
export type GraphBuildState = (typeof GRAPH_BUILD_STATES)[number];

/** The most repositories an account keeps a graph of. */
export const MAX_GRAPH_REPOS = 100;

/** The header naming the commit GET /api/graphs/repos/:id/graph answers with. */
export const GRAPH_COMMIT_HEADER = "x-ocra-graph-commit";

/** A repository as GET /api/graphs/repos lists it, with its newest build. */
export const graphRepoSchema = z.object({
  id: z.string(),
  platform: z.enum(CODE_PLATFORMS),
  // The platform's host, such as github.com or a GitLab instance's.
  host: z.string(),
  fullName: z.string(),
  branch: z.string(),
  latest: z
    .object({
      commit: z.string(),
      state: z.enum(GRAPH_BUILD_STATES),
      files: z.number().int().nonnegative().nullable(),
      bytes: z.number().int().nonnegative().nullable(),
      truncated: z.boolean(),
      error: z.string().nullable(),
      // ISO 8601.
      finishedAt: z.string().nullable(),
    })
    .nullable(),
});
export type GraphRepo = z.infer<typeof graphRepoSchema>;

/**
 * GET /api/graphs/repos. A client reads each repository on its own, and
 * skips one it cannot use (a platform it does not know).
 */
export const graphReposAnswerSchema = z.object({ repos: z.array(z.unknown()) });
