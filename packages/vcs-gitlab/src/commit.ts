import type { ChangeCommit, CommitResult } from "@open-cr-agent/core";
import { z } from "zod";
import { type GitLabApi, GitLabApiError } from "./client.js";

const sourceSchema = z.object({
  source_branch: z.string(),
  source_project_id: z.number(),
  target_project_id: z.number(),
});
const branchSchema = z.object({
  commit: z.object({ id: z.string() }),
  can_push: z.boolean().optional(),
});
const fileSchema = z.object({ last_commit_id: z.string() });
const createdSchema = z.object({ id: z.string() });

// One commit through the commits API on the merge request's source branch.
// GitLab takes no parent for it, so the branch is compared first, each
// updated file carries the commit that last changed it (GitLab refuses the
// update when another has since) and each new file is created (refused
// when one is there): a push in between never loses a line.
export async function gitlabCommit(
  api: GitLabApi,
  iid: number,
  commit: ChangeCommit,
): Promise<CommitResult> {
  const source = sourceSchema.parse(await api.request("GET", `/merge_requests/${iid}`));
  if (source.source_project_id !== source.target_project_id) {
    return refused("not_writable", "the branch is on a fork, which ocra's token cannot write to");
  }
  const branch = branchSchema.parse(
    await api.request("GET", `/repository/branches/${encodeURIComponent(source.source_branch)}`),
  );
  if (branch.commit.id !== commit.parent) {
    return refused("head_moved", "the branch moved after ocra read it");
  }
  if (branch.can_push === false) {
    return refused("not_writable", "ocra's token may not push to the branch");
  }
  const actions = [];
  for (const f of commit.files) {
    if (f.created) {
      actions.push({ action: "create", file_path: f.path, content: f.content });
      continue;
    }
    const path = `/repository/files/${encodeURIComponent(f.path)}?ref=${commit.parent}`;
    const { last_commit_id } = fileSchema.parse(await api.request("GET", path));
    actions.push({ action: "update", file_path: f.path, content: f.content, last_commit_id });
  }
  try {
    const created = createdSchema.parse(
      await api.request("POST", "/repository/commits", {
        branch: source.source_branch,
        commit_message: commit.message,
        actions,
      }),
    );
    return { committed: true, sha: created.id };
  } catch (error) {
    if (!(error instanceof GitLabApiError)) throw error;
    if (error.status === 400 && /already exists|changed since/i.test(error.message)) {
      return refused("head_moved", "the branch moved after ocra read it");
    }
    if (error.status === 403) {
      return refused("not_writable", `GitLab refused the commit: ${error.message}`);
    }
    throw error;
  }
}

const targetSchema = z.object({ target_branch: z.string() });

export async function gitlabBaseHead(api: GitLabApi, iid: number): Promise<string> {
  const { target_branch } = targetSchema.parse(await api.request("GET", `/merge_requests/${iid}`));
  const branch = branchSchema.parse(
    await api.request("GET", `/repository/branches/${encodeURIComponent(target_branch)}`),
  );
  return branch.commit.id;
}

// The branch a merge of ocra's is pushed to: one of the project itself that
// the token's account may push to.
export async function gitlabPushBranch(
  api: GitLabApi,
  iid: number,
): Promise<{ branch: string } | { refused: string }> {
  const source = sourceSchema.parse(await api.request("GET", `/merge_requests/${iid}`));
  if (source.source_project_id !== source.target_project_id) {
    return { refused: "the branch is on a fork, which ocra's token cannot write to" };
  }
  const branch = branchSchema.parse(
    await api.request("GET", `/repository/branches/${encodeURIComponent(source.source_branch)}`),
  );
  return branch.can_push === false
    ? { refused: "ocra's token may not push to the branch" }
    : { branch: source.source_branch };
}

function refused(outcome: "head_moved" | "not_writable", reason: string): CommitResult {
  return { committed: false, outcome, reason };
}
