import { z } from "zod";

const pullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  base: z.object({ sha: z.string(), ref: z.string() }),
  head: z.object({ sha: z.string(), ref: z.string() }),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

const commentSchema = z.object({
  id: z.number(),
  body: z
    .string()
    .nullable()
    .transform((b) => b ?? ""),
  user: z.object({ login: z.string(), type: z.string() }).nullable(),
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

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubApiOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

const MAX_COMMENT_PAGES = 30;
const MAX_THREAD_PAGES = 10;

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  resolvedBy: string | undefined;
  // In order; the first carries ocra's finding marker.
  comments: { author: string; body: string }[];
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved resolvedBy { login } comments(first: 30) { nodes { body author { login } } } }
      }
    }
  }
}`;

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
            comments: z.object({
              nodes: z.array(
                z.object({
                  body: z.string(),
                  author: z.object({ login: z.string() }).nullable(),
                }),
              ),
            }),
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
          comments: node.comments.nodes.map((c) => ({
            author: c.author?.login ?? "",
            body: c.body,
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

  private async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const result = z
      .object({
        data: z.unknown().optional(),
        errors: z.array(z.object({ message: z.string() })).optional(),
      })
      .parse(await this.send("POST", this.graphqlUrl(), "/graphql", { query, variables }));
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

  private async send(method: string, url: string, path: string, body?: unknown): Promise<unknown> {
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "open-cr-agent",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: AbortSignal.timeout(30_000),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.fetchImpl(url, init);
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new GitHubApiError(
        response.status,
        `GitHub ${method} ${path.split("?")[0]} failed with ${response.status}: ${detail}`,
      );
    }
    return response.status === 204 ? undefined : response.json();
  }
}
