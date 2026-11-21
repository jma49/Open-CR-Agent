import { setTimeout as wait } from "node:timers/promises";
import type { FileProposal, ProposedChange, ProposeOptions } from "@open-cr-agent/vcs-platform";
import { z } from "zod";
import { GitLabApiError } from "./client.js";
import { gitlabApi } from "./target.js";

const projectSchema = z.object({ default_branch: z.string().min(1) });
const treeSchema = z.array(z.object({ path: z.string(), type: z.string() }));
const mergeRequestSchema = z.object({
  iid: z.number(),
  web_url: z.string(),
  state: z.string().optional(),
  merge_status: z.string().optional(),
  head_pipeline: z.object({ id: z.number() }).nullish(),
  merge_when_pipeline_succeeds: z.boolean().optional(),
});
type MergeRequest = z.infer<typeof mergeRequestSchema>;

const MAX_TREE_PAGES = 10;
// GitLab makes a new merge request's pipeline and checks its mergeability
// after answering; these are the waits, in all about 15 seconds, for both.
const SETTLE_WAITS_MS = [1000, 2000, 3000, 4000, 5000];
const UNSETTLED = new Set(["unchecked", "checking", "preparing", "cannot_be_merged_recheck"]);

type Api = Awaited<ReturnType<typeof gitlabApi>>["api"];

// One commit on a new branch from the default branch, made through the
// commits API, so nothing is pushed from the checkout; then a merge request.
// The token needs the api scope and the Developer role.
export async function proposeOnGitLab(
  options: ProposeOptions,
  proposal: FileProposal,
): Promise<ProposedChange> {
  const warnings: string[] = [];
  const { api } = await gitlabApi(
    { ...options, warn: (message) => warnings.push(message) },
    options.repository,
    "--propose",
  );
  const base = projectSchema.parse(await api.request("GET", "")).default_branch;
  const existing = await existingPaths(
    api,
    base,
    proposal.files.map((f) => f.path),
  );
  await api.request("POST", "/repository/commits", {
    branch: proposal.branch,
    start_branch: base,
    commit_message: proposal.commitMessage,
    actions: proposal.files.map((f) => ({
      action: existing.has(f.path) ? "update" : "create",
      file_path: f.path,
      content: f.content,
    })),
  });
  const created = mergeRequestSchema.parse(
    await api.request("POST", "/merge_requests", {
      source_branch: proposal.branch,
      target_branch: base,
      title: proposal.title,
      description: proposal.body,
      remove_source_branch: true,
    }),
  );
  const webUrl = created.web_url;
  if (!proposal.autoMerge) return { webUrl, merge: "off", warnings };
  const merge = await mergeWhenGreen(api, created.iid, options);
  return { webUrl, merge: merge.merge, warnings: [...warnings, ...merge.warnings] };
}

// The paths among `paths` the default branch holds, from one listing of
// each directory rather than one request per file.
async function existingPaths(api: Api, ref: string, paths: readonly string[]) {
  const found = new Set<string>();
  const dirs = new Set(paths.map((p) => p.slice(0, Math.max(p.lastIndexOf("/"), 0))));
  for (const dir of dirs) {
    for (let page = 1; page <= MAX_TREE_PAGES; page += 1) {
      const query = `ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(dir)}&per_page=100&page=${page}`;
      let entries: z.infer<typeof treeSchema>;
      try {
        entries = treeSchema.parse(await api.request("GET", `/repository/tree?${query}`));
      } catch (error) {
        // A directory the branch does not have yet.
        if (error instanceof GitLabApiError && error.status === 404) break;
        throw error;
      }
      for (const entry of entries) if (entry.type === "blob") found.add(entry.path);
      if (entries.length < 100) break;
    }
  }
  return found;
}

// Merged when its pipeline succeeds. GitLab merges at once a merge request
// with no running pipeline, so the request waits for the pipeline a new
// branch starts; with none after the waits, nothing is required of it.
async function mergeWhenGreen(
  api: Api,
  iid: number,
  options: Pick<ProposeOptions, "sleep" | "signal">,
): Promise<Pick<ProposedChange, "merge" | "warnings">> {
  const sleep = options.sleep ?? ((ms: number) => wait(ms, undefined, { signal: options.signal }));
  let mergeRequest = await settled(api, iid, sleep);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = mergeRequestSchema.parse(
        await api.request("PUT", `/merge_requests/${iid}/merge`, {
          merge_when_pipeline_succeeds: true,
          should_remove_source_branch: true,
        }),
      );
      if (answer.state === "merged") return { merge: "merged", warnings: [] };
      if (answer.merge_when_pipeline_succeeds) return { merge: "enabled", warnings: [] };
      return unavailable("GitLab neither merged it nor set it to merge when its pipeline succeeds");
    } catch (error) {
      if (!(error instanceof GitLabApiError)) throw error;
      const retry = [405, 422].includes(error.status) && attempt < SETTLE_WAITS_MS.length;
      if (!retry || !UNSETTLED.has(mergeRequest.merge_status ?? "")) {
        return unavailable(error.message);
      }
      await sleep(SETTLE_WAITS_MS[attempt] ?? 0);
      mergeRequest = await get(api, iid);
    }
  }
}

async function settled(
  api: Api,
  iid: number,
  sleep: (ms: number) => Promise<unknown>,
): Promise<MergeRequest> {
  let mergeRequest = await get(api, iid);
  for (const ms of SETTLE_WAITS_MS) {
    if (mergeRequest.head_pipeline && !UNSETTLED.has(mergeRequest.merge_status ?? "")) break;
    await sleep(ms);
    mergeRequest = await get(api, iid);
  }
  return mergeRequest;
}

async function get(api: Api, iid: number): Promise<MergeRequest> {
  return mergeRequestSchema.parse(await api.request("GET", `/merge_requests/${iid}`));
}

function unavailable(reason: string): Pick<ProposedChange, "merge" | "warnings"> {
  return { merge: "unavailable", warnings: [`the merge request is left open: ${reason}`] };
}
