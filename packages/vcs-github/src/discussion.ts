import { type MentionRef, OcraError } from "@open-cr-agent/core";
import type { PlatformDiscussion } from "@open-cr-agent/vcs-platform";
import { type GitHubApi, GitHubApiError, type IssueComment } from "./client.js";

type Said = { author: string; body: string };

// A comment on the pull request, from either of GitHub's two kinds: one on
// the conversation, or one on a line of the diff (`inline`), whose thread
// is its first comment and the replies to it.
export async function githubDiscussion(
  api: GitHubApi,
  number: number,
  ref: MentionRef,
): Promise<PlatformDiscussion | undefined> {
  const id = Number(ref.id);
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  return ref.inline ? lineDiscussion(api, number, id) : conversation(api, number, id);
}

async function conversation(
  api: GitHubApi,
  number: number,
  id: number,
): Promise<PlatformDiscussion | undefined> {
  const comment = await notFoundAsUndefined(api.getIssueComment(id));
  if (!comment?.issue_url.endsWith(`/issues/${number}`)) return undefined;
  const all = await api.listIssueComments(number);
  return { comment: await asked(api, comment), ...around(all, comment.id) };
}

async function lineDiscussion(
  api: GitHubApi,
  number: number,
  id: number,
): Promise<PlatformDiscussion | undefined> {
  const comment = await notFoundAsUndefined(api.getLineComment(id));
  if (!comment?.pull_request_url.endsWith(`/pulls/${number}`)) return undefined;
  const root = comment.in_reply_to_id ?? comment.id;
  const thread = (await api.listLineComments(number))
    .filter((c) => c.id === root || c.in_reply_to_id === root)
    .sort((a, b) => a.id - b.id);
  const line = comment.line ?? comment.original_line ?? undefined;
  return {
    comment: await asked(api, comment),
    ...around(thread, comment.id),
    on: { path: comment.path, ...(line ? { line } : {}) },
    replyTo: String(root),
  };
}

async function asked(
  api: GitHubApi,
  comment: IssueComment,
): Promise<PlatformDiscussion["comment"]> {
  // Who edited a comment is the rules' to judge; unknown is refused.
  if (!comment.node_id) {
    throw new OcraError("VCS_API_FAILED", "the comment has no node id to look up its editor");
  }
  const editor = await api.commentEditor(comment.node_id);
  return {
    id: String(comment.id),
    body: comment.body,
    ...(comment.user ? { author: comment.user.login } : {}),
    ...(editor ? { editor } : {}),
  };
}

function around(comments: readonly IssueComment[], id: number): { earlier: Said[]; later: Said[] } {
  const said = (c: IssueComment): Said => ({ author: c.user?.login ?? "", body: c.body });
  return {
    earlier: comments.filter((c) => c.id < id).map(said),
    later: comments.filter((c) => c.id > id).map(said),
  };
}

async function notFoundAsUndefined<T>(request: Promise<T>): Promise<T | undefined> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return undefined;
    throw error;
  }
}
