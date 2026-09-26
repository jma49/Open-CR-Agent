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

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const { owner, repo } = this.repository;
    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
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
