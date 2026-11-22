import { type MentionRef, OcraError } from "@open-cr-agent/core";
import type { PlatformDiscussion } from "@open-cr-agent/vcs-platform";
import type { GitLabApi, Note } from "./client.js";

// A note on the merge request and the discussion it is in. Every note is in
// one on GitLab, a comment on the merge request as a whole too, so a reply
// always goes to its discussion; such a comment is read, as on GitHub,
// among the merge request's other comments.
export async function gitlabDiscussion(
  api: GitLabApi,
  iid: number,
  ref: MentionRef,
): Promise<PlatformDiscussion | undefined> {
  const id = Number(ref.id);
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;
  const discussions = await api.listDiscussions(iid);
  const discussion = discussions.find((d) => d.notes.some((n) => n.id === id));
  const conversation = discussion?.individual_note
    ? discussions.filter((d) => d.individual_note || d === discussion)
    : discussion
      ? [discussion]
      : [];
  const notes = conversation
    .flatMap((d) => d.notes)
    .filter((n) => !n.system)
    .sort((a, b) => a.id - b.id);
  const note = notes.find((n) => n.id === id);
  if (!discussion || !note) return undefined;
  const editors = await api.noteEditors(iid);
  if (!editors.has(id)) {
    throw new OcraError("VCS_API_FAILED", `GitLab did not say who last edited note ${id}`);
  }
  const editor = editors.get(id);
  const said = (n: Note) => ({ author: n.author.username, body: n.body });
  const at = notes.indexOf(note);
  const position = discussion.individual_note ? undefined : notes[0]?.position;
  return {
    comment: {
      id: String(id),
      author: note.author.username,
      body: note.body,
      ...(editor ? { editor } : {}),
    },
    earlier: notes.slice(0, at).map(said),
    later: notes.slice(at + 1).map(said),
    ...(position
      ? {
          on: {
            path: position.new_path,
            ...(position.new_line ? { line: position.new_line } : {}),
          },
        }
      : {}),
    replyTo: discussion.id,
  };
}
