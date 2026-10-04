import { OcraError } from "@open-cr-agent/core";
import { MAX_ATTEMPTS, retryDecision } from "@open-cr-agent/vcs-platform";
import { z } from "zod";

// Commit ids reach git as arguments; anything else is refused at the boundary.
const sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "not a commit id");

const pullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  base: z.object({ sha: sha, ref: z.string() }),
  head: z.object({ sha: sha, ref: z.string() }),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

const commentSchema = z.object({
  id: z.number(),
  body: z
    .string()
    .nullable()
    .transform((b) => b ?? ""),
  user: z.object({ login: z.string(), type: z.string() }).nullable(),
  node_id: z.string().optional(),
  author_association: z.string().optional(),
});
export type IssueComment = z.infer<typeof commentSchema>;

export interface ReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side: "RIGHT";
  start_side?: "RIGHT";
  body: string;
}

export interface CreateReview {
  commit_id: string;
  event: "COMMENT" | "REQUEST_CHANGES";
  body: string;
  comments: ReviewComment[];
}

export class GitHubApiError extends OcraError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super("VCS_API_FAILED", message);
    this.name = "GitHubApiError";
  }
}

export interface GitHubApiOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const reviewSchema = z.object({
  id: z.number(),
  state: z.string(),
  user: z.object({ login: z.string() }).nullable(),
});
export type PullRequestReview = z.infer<typeof reviewSchema>;
const MAX_REVIEW_PAGES = 10;
// GitHub lists at most 3,000 files of a pull request.
const MAX_FILE_PAGES = 30;
const pullRequestFileSchema = z.object({ filename: z.string(), patch: z.string().optional() });

const MAX_COMMENT_PAGES = 30;
const MAX_THREAD_PAGES = 10;

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  resolvedBy: string | undefined;
  // In order; the first carries ocra's finding marker. `editor` is set when
  // someone edited the comment after posting it.
  comments: { author: string; association: string; body: string; editor?: string }[];
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved resolvedBy { login } comments(first: 30) { nodes { id body authorAssociation author { login } editor { login } } } latest: comments(last: 30) { nodes { id body authorAssociation author { login } editor { login } } } }
      }
    }
  }
}`;

const graphqlResultSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string(), type: z.string().optional() })).optional(),
});
type GraphqlResult = z.infer<typeof graphqlResultSchema>;

const threadCommentsSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string().optional(),
      body: z.string(),
      authorAssociation: z.string().default("NONE"),
      author: z.object({ login: z.string() }).nullable(),
      editor: z.object({ login: z.string() }).nullable().optional(),
    }),
  ),
});
type ThreadComment = z.infer<typeof threadCommentsSchema>["nodes"][number];

// The first page (with ocra's marker comment) followed by the latest replies
// it did not include; the two overlap in threads of up to 60 comments.
function mergeComments(first: ThreadComment[], latest: ThreadComment[]): ThreadComment[] {
  const seen = new Set(first.map((c) => c.id).filter((id) => id !== undefined));
  return [...first, ...latest.filter((c) => c.id !== undefined && !seen.has(c.id))];
}

const reviewThreadsSchema = z.object({
  repository: z.object({
    pullRequest: z.object({
      reviewThreads: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(
          z.object({
            id: z.string(),
            isResolved: z.boolean(),
            resolvedBy: z.object({ login: z.string() }).nullable().optional(),
            comments: threadCommentsSchema,
            // A long thread's latest replies, which the first page misses.
            latest: threadCommentsSchema.optional(),
          }),
        ),
      }),
    }),
  }),
});

// A thin REST client: every response is validated before it reaches the
// adapter, and errors never echo the token.
export class GitHubApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly repository: { owner: string; repo: string },
    private readonly options: GitHubApiOptions,
  ) {
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listReviewThreads(number: number): Promise<ReviewThread[]> {
    const threads: ReviewThread[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
      const data = reviewThreadsSchema.parse(
        await this.graphql(REVIEW_THREADS_QUERY, {
          owner: this.repository.owner,
          repo: this.repository.repo,
          number,
          after,
        }),
      );
      const connection = data.repository.pullRequest.reviewThreads;
      for (const node of connection.nodes) {
        threads.push({
          id: node.id,
          isResolved: node.isResolved,
          resolvedBy: node.resolvedBy?.login,
          comments: mergeComments(node.comments.nodes, node.latest?.nodes ?? []).map((c) => ({
            author: c.author?.login ?? "",
            association: c.authorAssociation,
            body: c.body,
            ...(c.editor ? { editor: c.editor.login } : {}),
          })),
        });
      }
      if (!connection.pageInfo.hasNextPage) break;
      after = connection.pageInfo.endCursor;
    }
    return threads;
  }

  async resolveReviewThread(threadId: string): Promise<void> {
    await this.graphql(
      "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }",
      { id: threadId },
    );
  }

  // Who last edited a comment, if anyone did.
  async commentEditor(nodeId: string): Promise<string | undefined> {
    const data = z
      .object({
        node: z
          .object({ editor: z.object({ login: z.string() }).nullable().optional() })
          .nullable(),
      })
      .parse(
        await this.graphql(
          "query($id: ID!) { node(id: $id) { ... on IssueComment { editor { login } } } }",
          { id: nodeId },
        ),
      );
    return data.node?.editor?.login;
  }

  async getPullRequest(number: number): Promise<PullRequest> {
    return pullRequestSchema.parse(await this.request("GET", `/pulls/${number}`));
  }

  async listIssueComments(number: number): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
      const batch = z
        .array(commentSchema)
        .parse(await this.request("GET", `/issues/${number}/comments?per_page=100&page=${page}`));
      comments.push(...batch);
      if (batch.length < 100) break;
    }
    return comments;
  }

  async createIssueComment(number: number, body: string): Promise<void> {
    await this.request("POST", `/issues/${number}/comments`, { body });
  }

  async updateIssueComment(id: number, body: string): Promise<void> {
    await this.request("PATCH", `/issues/comments/${id}`, { body });
  }

  async createReview(number: number, review: CreateReview): Promise<void> {
    await this.request("POST", `/pulls/${number}/reviews`, review);
  }

  // Files GitHub shows a diff for; only their lines take inline comments.
  async filesWithDiff(number: number): Promise<Set<string>> {
    const files = new Set<string>();
    for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
      const batch = z
        .array(pullRequestFileSchema)
        .parse(await this.request("GET", `/pulls/${number}/files?per_page=100&page=${page}`));
      for (const f of batch) if (f.patch !== undefined) files.add(f.filename);
      if (batch.length < 100) break;
    }
    return files;
  }

  // The repository permission of a user: author_association only says how
  // someone relates to the repository (MEMBER is any organization member),
  // not whether they may write to it.
  async canWrite(login: string): Promise<boolean> {
    const data = z
      .object({ permission: z.string() })
      .parse(await this.request("GET", `/collaborators/${encodeURIComponent(login)}/permission`));
    return data.permission === "admin" || data.permission === "write";
  }

  async listReviews(number: number): Promise<PullRequestReview[]> {
    const reviews: PullRequestReview[] = [];
    for (let page = 1; page <= MAX_REVIEW_PAGES; page += 1) {
      const batch = z
        .array(reviewSchema)
        .parse(await this.request("GET", `/pulls/${number}/reviews?per_page=100&page=${page}`));
      reviews.push(...batch);
      if (batch.length < 100) break;
    }
    return reviews;
  }

  async dismissReview(number: number, reviewId: number, message: string): Promise<void> {
    await this.request("PUT", `/pulls/${number}/reviews/${reviewId}/dismissals`, {
      message,
      event: "DISMISS",
    });
  }

  // GraphQL reports its rate limit as an error in a 200 response, which the
  // HTTP retry does not see; it is retried here the same bounded way.
  private async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const sleep = this.options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    let result: GraphqlResult;
    for (let attempt = 1; ; attempt += 1) {
      result = graphqlResultSchema.parse(
        await this.send("POST", this.graphqlUrl(), "/graphql", { query, variables }, true),
      );
      const limited = result.errors?.some((e) => e.type === "RATE_LIMITED");
      if (!limited || attempt >= MAX_ATTEMPTS) break;
      await sleep(1_000 * 2 ** attempt);
    }
    if (result.errors?.length) {
      throw new GitHubApiError(
        200,
        `GitHub GraphQL failed: ${result.errors.map((e) => e.message).join("; ")}`,
      );
    }
    return result.data;
  }

  // github.com serves GraphQL at /graphql; GitHub Enterprise at /api/graphql
  // next to /api/v3.
  private graphqlUrl(): string {
    return this.baseUrl.endsWith("/api/v3")
      ? `${this.baseUrl.slice(0, -"/v3".length)}/graphql`
      : `${this.baseUrl}/graphql`;
  }

  private request(method: string, path: string, body?: unknown): Promise<unknown> {
    const { owner, repo } = this.repository;
    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
    return this.send(method, url, path, body);
  }

  // GraphQL queries and resolving a thread are safe to repeat, although they
  // are POSTs; REST POSTs create comments and reviews, and are not.
  private async send(
    method: string,
    url: string,
    path: string,
    body?: unknown,
    idempotent = method !== "POST",
  ): Promise<unknown> {
    const sleep = this.options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 1; ; attempt += 1) {
      const init: RequestInit = {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.options.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "open-cr-agent",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        // Creating a review with many inline comments can take GitHub a while,
        // and a POST that timed out after GitHub acted cannot be repeated.
        signal: AbortSignal.timeout(
          method === "POST" && path.endsWith("/reviews") ? 120_000 : 30_000,
        ),
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (error) {
        const next = retryDecision(method, idempotent, "network_error", attempt);
        if (!next.retry) throw error;
        await sleep(next.waitMs);
        continue;
      }
      if (response.ok) return response.status === 204 ? undefined : response.json();
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      const next = retryDecision(
        method,
        idempotent,
        { status: response.status, headers: response.headers, body: detail },
        attempt,
      );
      if (next.retry) {
        await sleep(next.waitMs);
        continue;
      }
      throw new GitHubApiError(
        response.status,
        `GitHub ${method} ${path.split("?")[0]} failed with ${response.status}: ${detail}`,
      );
    }
  }
}
