import type { FileProposal, ProposedChange, ProposeOptions } from "@open-cr-agent/vcs-platform";
import { z } from "zod";
import { GitHubApiError } from "./client.js";
import { githubApi } from "./target.js";

const repositorySchema = z.object({
  default_branch: z.string().min(1),
  allow_auto_merge: z.boolean().optional(),
  allow_squash_merge: z.boolean().optional(),
  allow_rebase_merge: z.boolean().optional(),
  allow_merge_commit: z.boolean().optional(),
});
const refSchema = z.object({ object: z.object({ sha: z.string() }) });
const shaSchema = z.object({ sha: z.string() });
const commitSchema = z.object({ tree: shaSchema });
const pullSchema = z.object({ number: z.number(), node_id: z.string(), html_url: z.string() });

type Repository = z.infer<typeof repositorySchema>;

// One commit on a new branch from the default branch, made through the Git
// data API, so nothing is pushed from the checkout; then a pull request.
// The token needs contents and pull request write access.
export async function proposeOnGitHub(
  options: ProposeOptions,
  proposal: FileProposal,
): Promise<ProposedChange> {
  const { api } = await githubApi(options, options.repository, "--propose");
  const repository = repositorySchema.parse(await api.request("GET", ""));
  const base = repository.default_branch;
  const head = refSchema.parse(
    await api.request("GET", `/git/ref/heads/${encodeURIComponent(base)}`),
  ).object.sha;
  const baseTree = commitSchema.parse(await api.request("GET", `/git/commits/${head}`)).tree.sha;
  const tree = shaSchema.parse(
    await api.request("POST", "/git/trees", {
      base_tree: baseTree,
      tree: proposal.files.map((f) => ({
        path: f.path,
        mode: "100644",
        type: "blob",
        content: f.content,
      })),
    }),
  ).sha;
  const commit = shaSchema.parse(
    await api.request("POST", "/git/commits", {
      message: proposal.commitMessage,
      tree,
      parents: [head],
    }),
  ).sha;
  await api.request("POST", "/git/refs", { ref: `refs/heads/${proposal.branch}`, sha: commit });
  const pull = pullSchema.parse(
    await api.request("POST", "/pulls", {
      title: proposal.title,
      body: proposal.body,
      head: proposal.branch,
      base,
    }),
  );
  if (!proposal.autoMerge) return { webUrl: pull.html_url, merge: "off", warnings: [] };
  return { webUrl: pull.html_url, ...(await mergeWhenGreen(api, repository, pull)) };
}

type Api = Awaited<ReturnType<typeof githubApi>>["api"];

async function mergeWhenGreen(
  api: Api,
  repository: Repository,
  pull: z.infer<typeof pullSchema>,
): Promise<Pick<ProposedChange, "merge" | "warnings">> {
  const method = mergeMethod(repository);
  if (!method) {
    return unavailable("the repository allows no merge method");
  }
  if (!repository.allow_auto_merge) {
    return unavailable("auto-merge is off in the repository's settings; a person merges it");
  }
  try {
    await api.graphql(
      "mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { clientMutationId } }",
      { id: pull.node_id, method: method.toUpperCase() },
    );
    return { merge: "enabled", warnings: [] };
  } catch (error) {
    // GitHub refuses auto-merge on a pull request nothing is required of:
    // its checks have passed, vacuously, so it is merged now.
    if (!(error instanceof GitHubApiError)) throw error;
    if (!/clean status/i.test(error.message)) return unavailable(error.message);
  }
  try {
    await api.request("PUT", `/pulls/${pull.number}/merge`, { merge_method: method });
    return { merge: "merged", warnings: [] };
  } catch (error) {
    if (!(error instanceof GitHubApiError)) throw error;
    return unavailable(error.message);
  }
}

function mergeMethod(repository: Repository): "squash" | "rebase" | "merge" | undefined {
  if (repository.allow_squash_merge !== false) return "squash";
  if (repository.allow_rebase_merge !== false) return "rebase";
  if (repository.allow_merge_commit !== false) return "merge";
  return undefined;
}

function unavailable(reason: string): Pick<ProposedChange, "merge" | "warnings"> {
  return { merge: "unavailable", warnings: [`the pull request is left open: ${reason}`] };
}
