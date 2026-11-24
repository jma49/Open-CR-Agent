import type { PlatformCheck } from "@open-cr-agent/vcs-platform";
import { LOG_TAIL_BYTES } from "@open-cr-agent/vcs-platform/internal";
import { z } from "zod";
import { type GitLabApi, GitLabApiError } from "./client.js";

// A pipeline with more jobs than these pages hold is read in part.
const MAX_PAGES = 3;
const PER_PAGE = 100;
const UNFINISHED = new Set([
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "scheduled",
]);

const pipelineSchema = z.object({ id: z.number(), sha: z.string() });
const jobSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  allow_failure: z.boolean().optional(),
});
const targetSchema = z.object({ target_branch: z.string() });

// The jobs of the merge request's newest pipeline on a commit; none when it
// has no pipeline there.
export async function gitlabChecks(
  api: GitLabApi,
  iid: number,
  sha: string,
): Promise<PlatformCheck[]> {
  const pipelines = z
    .array(pipelineSchema)
    .parse(await api.request("GET", `/merge_requests/${iid}/pipelines?per_page=${PER_PAGE}`));
  const pipeline = pipelines.find((p) => p.sha === sha);
  return pipeline ? jobsOf(api, pipeline.id) : [];
}

export async function gitlabFailingOnBase(api: GitLabApi, iid: number): Promise<string[]> {
  const { target_branch } = targetSchema.parse(await api.request("GET", `/merge_requests/${iid}`));
  const ref = encodeURIComponent(target_branch);
  const [latest] = z
    .array(pipelineSchema)
    .parse(await api.request("GET", `/pipelines?ref=${ref}&per_page=1`));
  if (!latest) return [];
  const jobs = await jobsOf(api, latest.id);
  return jobs.filter((job) => job.state === "failed").map((job) => job.name);
}

// A retried job is listed under its latest run. A job allowed to fail does
// not fail its pipeline, and a manual one waits for a person, not for time.
async function jobsOf(api: GitLabApi, pipeline: number): Promise<PlatformCheck[]> {
  const checks: PlatformCheck[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const path = `/pipelines/${pipeline}/jobs?per_page=${PER_PAGE}&page=${page}`;
    const batch = z.array(jobSchema).parse(await api.request("GET", path));
    for (const job of batch) {
      checks.push({
        name: job.name,
        state: UNFINISHED.has(job.status)
          ? "pending"
          : job.status === "failed" && job.allow_failure !== true
            ? "failed"
            : "passed",
        log: () => traceOf(api, job.id),
      });
    }
    if (batch.length < PER_PAGE) break;
  }
  return checks;
}

async function traceOf(api: GitLabApi, job: number): Promise<string> {
  try {
    return await api.tail(`/jobs/${job}/trace`, LOG_TAIL_BYTES);
  } catch (error) {
    if (error instanceof GitLabApiError && [403, 404].includes(error.status)) return "";
    throw error;
  }
}
