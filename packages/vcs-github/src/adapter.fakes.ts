import type { Finding, ReviewReport } from "@open-cr-agent/core";
import type { CodeSource } from "./adapter.js";
import { GitHubAdapter } from "./adapter.js";
import { GitHubApi } from "./client.js";
import { SUMMARY_MARKER } from "./state.js";

// Fakes shared by the GitHub adapter tests.
export interface Call {
  method: string;
  path: string;
  body?: unknown;
}

export function fakeGitHub(
  comments: unknown[] = [],
  reviewStatus = 200,
  threads: unknown[] = [],
  graphqlFails = false,
  editor: { login: string } | null = null,
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.github.com/repos/o/r", "");
    const method = init?.method ?? "GET";
    const call: Call = { method, path };
    if (init?.body) call.body = JSON.parse(init.body as string);
    calls.push(call);
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.endsWith("/graphql")) {
      if (graphqlFails) return json(502, { message: "Bad gateway" });
      const query = (call.body as { query: string }).query;
      if (query.includes("editor")) return json(200, { data: { node: { editor } } });
      if (query.startsWith("mutation"))
        return json(200, { data: { resolveReviewThread: { thread: {} } } });
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads },
            },
          },
        },
      });
    }
    if (path === "/pulls/7") {
      return json(200, {
        number: 7,
        title: "Add login",
        body: null,
        html_url: "https://github.com/o/r/pull/7",
        user: { login: "author" },
        base: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ref: "main" },
        head: { sha: "cccccccccccccccccccccccccccccccccccccccc", ref: "feat" },
      });
    }
    if (path.startsWith("/issues/7/comments") && method === "GET") return json(200, comments);
    if (path === "/pulls/7/reviews") {
      const rejected =
        reviewStatus !== 200 && (call.body as { comments: unknown[] }).comments.length > 0;
      return rejected ? json(reviewStatus, { message: "Unprocessable" }) : json(200, {});
    }
    return json(201, {});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

export const code: CodeSource = {
  getDiff: async () => [],
  readFile: async () => undefined,
  searchCode: async () => [],
};

export function adapter(fetchImpl: typeof fetch, requestChanges = false) {
  return new GitHubAdapter({
    pullRequest: { owner: "o", repo: "r", number: 7 },
    api: new GitHubApi({ owner: "o", repo: "r" }, { token: "t", fetch: fetchImpl }),
    code,
    botLogin: "github-actions[bot]",
    requestChanges,
  });
}

export function finding(
  fingerprint: string,
  inDiff: boolean,
  severity: Finding["severity"] = "warning",
): Finding {
  return {
    id: fingerprint,
    fingerprint,
    reviewer: "security",
    category: "security",
    severity,
    file: "src/login.ts",
    existingCode: "x",
    title: `Issue ${fingerprint.slice(0, 2)} @here <img src=x>`,
    body: "Body",
    evidence: [],
    lineRange: { start: 3, end: 4 },
    anchor: { method: inDiff ? "hunk" : "file", inDiff },
    status: "new",
  };
}

export function report(
  findings: Finding[],
  verdict: ReviewReport["verdict"] = "approved_with_comments",
): ReviewReport {
  return {
    changeRequest: {
      id: "o/r#7",
      title: "t",
      description: "",
      baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      headSha: "cccccccccccccccccccccccccccccccccccccccc",
    },
    tier: "lite",
    verdict,
    summary: "Summary.",
    coverage: [{ path: "src/login.ts", status: "reviewed" }],
    bundles: [],
    unverifiedCriticals: 0,
    tasks: [],
    skipped: [],
    findings,
    refuted: [],
    remembered: [],
    usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, costUsd: 0.01 },
    warnings: [],
  };
}

export function postedSummary(calls: Call[]): string {
  const post = calls.find((c) => c.method === "POST" && c.path === "/issues/7/comments");
  if (!post) throw new Error("no summary comment was posted");
  return (post.body as { body: string }).body;
}

export const A = "aaaaaaaaaaaaaaaa";
export const B = "bbbbbbbbbbbbbbbb";
