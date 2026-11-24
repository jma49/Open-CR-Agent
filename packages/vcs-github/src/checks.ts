import type { PlatformCheck } from "@open-cr-agent/vcs-platform";
import { LOG_TAIL_BYTES } from "@open-cr-agent/vcs-platform/internal";
import { z } from "zod";
import { type GitHubApi, GitHubApiError } from "./client.js";

// A commit with more check runs than these pages hold is read in part.
const MAX_PAGES = 3;
const ACTIONS = "github-actions";

const runSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  app: z.object({ slug: z.string().optional() }).nullable().optional(),
  output: z
    .object({
      title: z.string().nullable().optional(),
      summary: z.string().nullable().optional(),
      text: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
type Run = z.infer<typeof runSchema>;
const runsSchema = z.object({ check_runs: z.array(runSchema) });
const baseSchema = z.object({ base: z.object({ ref: z.string() }) });

// The check runs of a commit, each name's latest. A cancelled, skipped or
// neutral run is not a failure: nothing in the code made it end that way.
export async function githubChecks(api: GitHubApi, ref: string): Promise<PlatformCheck[]> {
  const runs: Run[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const path = `/commits/${ref}/check-runs?filter=latest&per_page=100&page=${page}`;
    const batch = runsSchema.parse(await api.request("GET", path)).check_runs;
    runs.push(...batch);
    if (batch.length < 100) break;
  }
  return runs.map((run) => ({
    name: run.name,
    state:
      run.status !== "completed"
        ? "pending"
        : run.conclusion === "failure" || run.conclusion === "timed_out"
          ? "failed"
          : "passed",
    log: () => logOf(api, run),
  }));
}

export async function githubFailingOnBase(api: GitHubApi, number: number): Promise<string[]> {
  const { base } = baseSchema.parse(await api.request("GET", `/pulls/${number}`));
  const ref = base.ref.split("/").map(encodeURIComponent).join("/");
  const checks = await githubChecks(api, `heads/${ref}`);
  return checks.filter((c) => c.state === "failed").map((c) => c.name);
}

// An Actions check run is its job, whose log the token reads with
// `actions: read`; any other app's run has only what it reported.
async function logOf(api: GitHubApi, run: Run): Promise<string> {
  if (run.app?.slug === ACTIONS) {
    try {
      const log = await api.tail(`/actions/jobs/${run.id}/logs`, LOG_TAIL_BYTES);
      if (log.trim() !== "") return log;
    } catch (error) {
      if (!(error instanceof GitHubApiError) || ![403, 404, 410].includes(error.status)) {
        throw error;
      }
    }
  }
  const { title, summary, text } = run.output ?? {};
  return [title, summary, text].filter((part) => part).join("\n");
}
