import { type FileDiff, OcraError, type ReviewReport } from "@open-cr-agent/core";
import { errorMessage } from "@open-cr-agent/core/internal";
import {
  type Bot,
  type CodeSource,
  type History,
  type InlineFinding,
  type PlatformChangeRequest,
  type PlatformComment,
  PlatformReview,
  type PlatformThread,
  type PublishedFindings,
  type ReviewPlatform,
} from "@open-cr-agent/vcs-platform";
import {
  DEVELOPER,
  type GitLabApi,
  GitLabApiError,
  type MergeRequest,
  type Note,
  type Position,
} from "./client.js";

export interface GitLabAdapterOptions {
  // The merge request's number in its project (iid, not the global id).
  iid: number;
  api: GitLabApi;
  code: CodeSource;
  history?: History;
  // The merge request as the diff under review was built from it. Without it
  // the adapter fetches the merge request itself, and a push in between would
  // publish the new head for the old diff.
  snapshot?: MergeRequest;
}

// A GitLab merge request as ocra's review conversation (vcs-platform).
export class GitLabAdapter extends PlatformReview {
  constructor(options: GitLabAdapterOptions) {
    super({
      name: "gitlab",
      platform: new GitLabPlatform(options),
      code: options.code,
      ...(options.history ? { history: options.history } : {}),
    });
  }
}

// A note whose editor is not in the GraphQL answer (past its page cap) reads
// as edited by nobody who could be its author or ocra: the rules then ignore
// it rather than trust it. Parentheses cannot occur in a GitLab username.
const UNKNOWN_EDITOR = "(unknown)";

class GitLabPlatform implements ReviewPlatform {
  readonly text = { changeRequest: "merge request", authority: "the Developer role or higher" };
  private mergeRequest: Promise<MergeRequest> | undefined;
  private user: Promise<{ id: number; username: string }> | undefined;
  private editors: Promise<Map<number, string | undefined>> | undefined;
  // User ids by username, from the notes read, for membership lookups.
  private readonly ids = new Map<string, number>();

  constructor(private readonly options: GitLabAdapterOptions) {}

  // The token's own user: a project access token has a bot user of its own.
  async bot(): Promise<Bot> {
    this.user ??= this.options.api.currentUser();
    const { username } = await this.user;
    return { login: username, is: (other) => other === username };
  }

  async changeRequest(): Promise<PlatformChangeRequest> {
    const mr = await this.mr();
    const refs = diffRefs(mr);
    return {
      id: `${projectPath(mr.web_url)}!${mr.iid}`,
      title: mr.title,
      description: mr.description ?? "",
      baseSha: refs.start_sha,
      headSha: refs.head_sha,
      ...(mr.author ? { author: mr.author.username } : {}),
    };
  }

  // Comments on the merge request as a whole: plain notes and the notes of
  // threads started on it, not notes on lines or system notes.
  async comments(): Promise<PlatformComment[]> {
    const notes = await this.options.api.listNotes(this.options.iid);
    return notes
      .filter((n) => !n.system && n.type !== "DiffNote")
      .map((n) => {
        this.remember(n);
        return { id: String(n.id), author: n.author.username, body: n.body };
      });
  }

  async editor(comment: PlatformComment): Promise<string | undefined> {
    const editors = await this.noteEditors();
    const id = Number(comment.id);
    if (!editors.has(id)) {
      throw new OcraError("VCS_API_FAILED", `GitLab did not say who last edited note ${id}`);
    }
    return editors.get(id);
  }

  async canWrite(login: string): Promise<boolean> {
    const id = this.ids.get(login) ?? (await this.options.api.findUser(login));
    if (id === undefined) return false;
    return (await this.options.api.accessLevel(id)) >= DEVELOPER;
  }

  async threads(): Promise<PlatformThread[]> {
    const discussions = await this.options.api.listDiscussions(this.options.iid);
    // Without editors every reply would read as unedited, so no threads.
    // Read after the discussions, not reused from the summary's check: a note
    // edited in between then reads as edited, never as unedited.
    const editors = await this.options.api.noteEditors(this.options.iid);
    // Where a push resolves outdated threads, GitLab records the pusher as
    // the one who resolved them, so no resolution says who dismissed what.
    const attributable =
      (await this.options.api.resolvesOutdatedThreads().catch(() => undefined)) === false;
    return discussions
      .filter((d) => !d.individual_note)
      .flatMap((d) => {
        const notes = d.notes.filter((n) => !n.system);
        const first = notes[0];
        if (!first) return [];
        for (const n of notes) this.remember(n);
        return [
          {
            id: d.id,
            resolved: first.resolved === true,
            ...(first.resolved_by && attributable
              ? { resolvedBy: first.resolved_by.username }
              : {}),
            comments: notes.map((n) => {
              const editor = editors.has(n.id) ? editors.get(n.id) : UNKNOWN_EDITOR;
              return { author: n.author.username, body: n.body, ...(editor ? { editor } : {}) };
            }),
          },
        ];
      });
  }

  // One thread per finding, each its own request: a position GitLab
  // rejects (400) leaves that finding in the summary, and any other failure
  // is a warning, so one bad comment never costs the rest or the summary.
  async publishFindings(
    _report: ReviewReport,
    fresh: readonly InlineFinding[],
  ): Promise<PublishedFindings> {
    if (fresh.length === 0) return { posted: [], warnings: [] };
    const refs = diffRefs(await this.mr());
    const diffs = await this.options.code.getDiff();
    const posted: string[] = [];
    const warnings: string[] = [];
    for (const { finding, body } of fresh) {
      const position = positionOf(finding.file, finding.lineRange.end, diffs, refs);
      if (!position) continue;
      try {
        await this.options.api.createDiscussion(this.options.iid, body, position);
        posted.push(finding.fingerprint);
      } catch (error) {
        if (error instanceof GitLabApiError && error.status === 400) continue;
        warnings.push(
          `could not comment on ${finding.file}:${finding.lineRange.end}: ${errorMessage(error)}`,
        );
      }
    }
    return { posted, warnings };
  }

  async writeSummary(existing: PlatformComment | undefined, body: string): Promise<void> {
    if (existing) await this.options.api.updateNote(this.options.iid, Number(existing.id), body);
    else await this.options.api.createNote(this.options.iid, body);
  }

  resolveThread(id: string): Promise<void> {
    return this.options.api.resolveDiscussion(this.options.iid, id);
  }

  private remember(note: Note): void {
    this.ids.set(note.author.username, note.author.id);
    if (note.resolved_by) this.ids.set(note.resolved_by.username, note.resolved_by.id);
  }

  private noteEditors(): Promise<Map<number, string | undefined>> {
    this.editors ??= this.options.api.noteEditors(this.options.iid);
    return this.editors;
  }

  private mr(): Promise<MergeRequest> {
    this.mergeRequest ??= this.options.snapshot
      ? Promise.resolve(this.options.snapshot)
      : this.options.api.getMergeRequest(this.options.iid);
    return this.mergeRequest;
  }
}

function diffRefs(mr: MergeRequest): NonNullable<MergeRequest["diff_refs"]> {
  if (!mr.diff_refs) {
    throw new OcraError(
      "VCS_NOT_READY",
      `merge request !${mr.iid} has no diff yet; try again shortly`,
    );
  }
  return mr.diff_refs;
}

// "https://gitlab.example.com/group/sub/project/-/merge_requests/7" names
// the project "group/sub/project".
function projectPath(webUrl: string): string {
  try {
    return new URL(webUrl).pathname.split("/-/")[0]?.replace(/^\/+/, "") ?? webUrl;
  } catch {
    return webUrl;
  }
}

// Where GitLab puts a comment on the new version's line: an added line takes
// its new number, an unchanged one both; a line outside the diff has none.
export function positionOf(
  file: string,
  line: number,
  diffs: readonly FileDiff[],
  refs: NonNullable<MergeRequest["diff_refs"]>,
): Position | undefined {
  const diff = diffs.find((d) => d.newPath === file);
  if (!diff) return undefined;
  for (const hunk of diff.hunks) {
    for (const l of hunk.lines) {
      if (l.kind === "delete" || l.newLine !== line) continue;
      return {
        position_type: "text",
        base_sha: refs.base_sha,
        start_sha: refs.start_sha,
        head_sha: refs.head_sha,
        old_path: diff.oldPath,
        new_path: diff.newPath,
        new_line: line,
        ...(l.kind === "context" ? { old_line: l.oldLine } : {}),
      };
    }
  }
  return undefined;
}
