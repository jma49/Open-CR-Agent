import type { ChangeCommit, CommitResult } from "@open-cr-agent/core";
import { z } from "zod";
import { type GitHubApi, GitHubApiError } from "./client.js";

const headSchema = z.object({
  head: z.object({
    sha: z.string(),
    ref: z.string(),
    // Null once the fork the branch was on is deleted.
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});
const shaSchema = z.object({ sha: z.string() });
const commitSchema = z.object({ tree: shaSchema });

// One commit through the Git data API, on top of the head ocra read, then
// the branch moved to it without force: GitHub refuses that unless it is a
// fast-forward, so a push in between is never overwritten.
export async function githubCommit(
  api: GitHubApi,
  pullRequest: { owner: string; repo: string; number: number },
  commit: ChangeCommit,
): Promise<CommitResult> {
  const { head } = headSchema.parse(await api.request("GET", `/pulls/${pullRequest.number}`));
  const own = `${pullRequest.owner}/${pullRequest.repo}`.toLowerCase();
  if (head.repo?.full_name.toLowerCase() !== own) {
    return refused("not_writable", "the branch is on a fork, which ocra's token cannot write to");
  }
  if (head.sha !== commit.parent) {
    return refused("head_moved", "the branch moved after ocra read it");
  }
  const tree = commitSchema.parse(await api.request("GET", `/git/commits/${commit.parent}`)).tree;
  try {
    const written = shaSchema.parse(
      await api.request("POST", "/git/trees", {
        base_tree: tree.sha,
        tree: commit.files.map((f) => ({
          path: f.path,
          mode: f.executable ? "100755" : "100644",
          type: "blob",
          content: f.content,
        })),
      }),
    );
    const created = shaSchema.parse(
      await api.request("POST", "/git/commits", {
        message: commit.message,
        tree: written.sha,
        parents: [commit.parent],
      }),
    );
    const ref = head.ref.split("/").map(encodeURIComponent).join("/");
    await api.request("PATCH", `/git/refs/heads/${ref}`, { sha: created.sha, force: false });
    return { committed: true, sha: created.sha };
  } catch (error) {
    if (!(error instanceof GitHubApiError)) throw error;
    if (error.status === 422 && /fast.forward/i.test(error.message)) {
      return refused("head_moved", "the branch moved after ocra read it");
    }
    if ([403, 404, 422].includes(error.status)) {
      return refused("not_writable", `GitHub refused the commit: ${error.message}`);
    }
    throw error;
  }
}

function refused(outcome: "head_moved" | "not_writable", reason: string): CommitResult {
  return { committed: false, outcome, reason };
}
