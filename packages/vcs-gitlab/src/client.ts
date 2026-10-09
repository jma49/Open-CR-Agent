import { OcraError } from "@open-cr-agent/core";
import {
  type PlatformApi,
  pageInfoSchema,
  sendWithRetry,
} from "@open-cr-agent/vcs-platform/internal";
import { z } from "zod";

// Commit ids reach git as arguments; anything else is refused at the boundary.
const sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "not a commit id");
const user = z.object({ id: z.number(), username: z.string() });

const mergeRequestSchema = z.object({
  iid: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  author: user.nullable(),
  web_url: z.string(),
  source_project_id: z.number(),
  target_project_id: z.number(),
  // Null while GitLab is still preparing the diff of a new merge request.
  diff_refs: z.object({ base_sha: sha, start_sha: sha, head_sha: sha }).nullable(),
});
export type MergeRequest = z.infer<typeof mergeRequestSchema>;

const noteSchema = z.object({
  id: z.number(),
  body: z.string(),
  author: user,
  system: z.boolean(),
  // null for a plain comment, "DiscussionNote" in a thread, "DiffNote" on a line.
  type: z.string().nullable(),
  resolvable: z.boolean().optional(),
  resolved: z.boolean().optional(),
  resolved_by: user.nullable().optional(),
});
export type Note = z.infer<typeof noteSchema>;

const discussionSchema = z.object({
  id: z.string(),
  individual_note: z.boolean(),
  notes: z.array(noteSchema),
});
export type Discussion = z.infer<typeof discussionSchema>;

// Where an inline comment goes: GitLab takes the new line for an added line,
// and both lines for an unchanged one.
export interface Position {
  position_type: "text";
  base_sha: string;
  start_sha: string;
  head_sha: string;
  old_path: string;
  new_path: string;
  new_line: number;
  old_line?: number;
}

export class GitLabApiError extends OcraError {
  readonly status: number;

  constructor(status: number, message: string) {
    super("VCS_API_FAILED", message);
    this.status = status;
    this.name = "GitLabApiError";
  }
}

export interface GitLabApiOptions {
  token: string;
  // The REST API of the instance, such as https://gitlab.example.com/api/v4
  // (GitLab CI's CI_API_V4_URL).
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  // Stops every request and every wait before a retry.
  signal?: AbortSignal;
}

const PER_PAGE = 100;
const MAX_NOTE_PAGES = 30;
const MAX_DISCUSSION_PAGES = 10;
const MAX_EDITOR_PAGES = 30;
const REQUEST_TIMEOUT_MS = 30_000;
// Developer: may push to unprotected branches, the nearest to GitHub's write.
export const DEVELOPER = 30;

const EDITORS_QUERY = `query($path: ID!, $iid: String!, $after: String) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      notes(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id lastEditedBy { username } }
      }
    }
  }
}`;

const editorsSchema = z.object({
  project: z.object({
    mergeRequest: z.object({
      notes: z.object({
        pageInfo: pageInfoSchema,
        nodes: z.array(
          z.object({
            id: z.string(),
            lastEditedBy: z.object({ username: z.string() }).nullable().optional(),
          }),
        ),
      }),
    }),
  }),
});

// A thin REST and GraphQL client for one project: every response is
// validated before it reaches the adapter, and errors never echo the token.
export class GitLabApi {
  private readonly baseUrl: string;
  private readonly api: PlatformApi;

  // `project` is the numeric id or the full path ("group/project").
  private readonly project: string | number;

  constructor(project: string | number, options: GitLabApiOptions) {
    this.project = project;
    this.baseUrl = (options.baseUrl ?? "https://gitlab.com/api/v4").replace(/\/+$/, "");
    this.api = {
      platform: "GitLab",
      headers: { Accept: "application/json", Authorization: `Bearer ${options.token}` },
      fetch: options.fetch ?? fetch,
      sleep: options.sleep,
      signal: options.signal,
      timeoutMs: () => REQUEST_TIMEOUT_MS,
      toError: (status, message) => new GitLabApiError(status, message),
    };
  }

  async currentUser(): Promise<{ id: number; username: string }> {
    return user.parse(
      await sendWithRetry(this.api, { method: "GET", url: `${this.baseUrl}/user`, path: "/user" }),
    );
  }

  // The project's full path, which GraphQL takes instead of the id.
  async fullPath(): Promise<string> {
    const data = z.object({ path_with_namespace: z.string() }).parse(await this.request("GET", ""));
    return data.path_with_namespace;
  }

  // Whether a push resolves the threads on lines it changed, recording the
  // pusher as the one who resolved them; undefined when GitLab does not say.
  async resolvesOutdatedThreads(): Promise<boolean | undefined> {
    const data = z
      .object({ resolve_outdated_diff_discussions: z.boolean().nullish() })
      .parse(await this.request("GET", ""));
    return data.resolve_outdated_diff_discussions ?? undefined;
  }

  async getMergeRequest(iid: number): Promise<MergeRequest> {
    return mergeRequestSchema.parse(await this.request("GET", `/merge_requests/${iid}`));
  }

  async listNotes(iid: number): Promise<Note[]> {
    return this.pages(
      `/merge_requests/${iid}/notes?sort=asc&order_by=created_at`,
      noteSchema,
      MAX_NOTE_PAGES,
    );
  }

  async listDiscussions(iid: number): Promise<Discussion[]> {
    return this.pages(`/merge_requests/${iid}/discussions`, discussionSchema, MAX_DISCUSSION_PAGES);
  }

  async createNote(iid: number, body: string): Promise<void> {
    await this.request("POST", `/merge_requests/${iid}/notes`, { body });
  }

  async updateNote(iid: number, noteId: number, body: string): Promise<void> {
    await this.request("PUT", `/merge_requests/${iid}/notes/${noteId}`, { body });
  }

  async createDiscussion(iid: number, body: string, position: Position): Promise<void> {
    await this.request("POST", `/merge_requests/${iid}/discussions`, { body, position });
  }

  async resolveDiscussion(iid: number, discussionId: string): Promise<void> {
    await this.request(
      "PUT",
      `/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}?resolved=true`,
    );
  }

  // The user's role in the project, inherited from groups included; 0 when
  // they are not a member.
  async accessLevel(userId: number): Promise<number> {
    try {
      const data = z
        .object({ access_level: z.number() })
        .parse(await this.request("GET", `/members/all/${userId}`));
      return data.access_level;
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === 404) return 0;
      throw error;
    }
  }

  async findUser(username: string): Promise<number | undefined> {
    const found = z.array(user).parse(
      await sendWithRetry(this.api, {
        method: "GET",
        url: `${this.baseUrl}/users?username=${encodeURIComponent(username)}`,
        path: "/users",
      }),
    );
    return found.find((u) => u.username === username)?.id;
  }

  // Who last edited each note of the merge request, by note id; REST does
  // not say, and a note's updated_at also moves when its thread is resolved.
  async noteEditors(iid: number): Promise<Map<number, string | undefined>> {
    const path = await this.fullPath();
    const editors = new Map<number, string | undefined>();
    let after: string | null = null;
    for (let page = 0; page < MAX_EDITOR_PAGES; page += 1) {
      const data = editorsSchema.parse(
        await this.graphql(EDITORS_QUERY, { path, iid: String(iid), after }),
      );
      const { nodes, pageInfo } = data.project.mergeRequest.notes;
      for (const node of nodes) {
        const id = Number(node.id.slice(node.id.lastIndexOf("/") + 1));
        if (Number.isInteger(id)) editors.set(id, node.lastEditedBy?.username);
      }
      if (!pageInfo.hasNextPage) break;
      after = pageInfo.endCursor;
    }
    return editors;
  }

  private async pages<T>(path: string, schema: z.ZodType<T>, maxPages: number): Promise<T[]> {
    const items: T[] = [];
    const joiner = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = z
        .array(schema)
        .parse(await this.request("GET", `${path}${joiner}per_page=${PER_PAGE}&page=${page}`));
      items.push(...batch);
      if (batch.length < PER_PAGE) break;
    }
    return items;
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const url = this.baseUrl.endsWith("/api/v4")
      ? `${this.baseUrl.slice(0, -"/v4".length)}/graphql`
      : `${this.baseUrl}/graphql`;
    const result = z
      .object({
        data: z.unknown().optional(),
        errors: z.array(z.object({ message: z.string() })).optional(),
      })
      .parse(
        await sendWithRetry(this.api, {
          method: "POST",
          url,
          path: "/graphql",
          body: { query, variables },
          // GraphQL queries are safe to repeat, although they are POSTs.
          idempotent: true,
        }),
      );
    if (result.errors?.length) {
      throw new GitLabApiError(
        200,
        `GitLab GraphQL failed: ${result.errors.map((e) => e.message).join("; ")}`,
      );
    }
    return result.data;
  }

  private request(method: string, path: string, body?: unknown): Promise<unknown> {
    const project = encodeURIComponent(String(this.project));
    const url = `${this.baseUrl}/projects/${project}${path}`;
    return sendWithRetry(this.api, { method, url, path, body });
  }
}
