import type { Finding, ReviewReport } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { type CodeSource, GitHubAdapter } from "./adapter.js";
import { GitHubApi } from "./client.js";
import { readState, SUMMARY_MARKER, writeState } from "./state.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function fakeGitHub(comments: unknown[] = [], reviewStatus = 200) {
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
    if (path === "/pulls/7") {
      return json(200, {
        number: 7,
        title: "Add login",
        body: null,
        html_url: "https://github.com/o/r/pull/7",
        base: { sha: "base", ref: "main" },
        head: { sha: "head", ref: "feat" },
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

const code: CodeSource = {
  getDiff: async () => [],
  readFile: async () => undefined,
  searchCode: async () => [],
};

function adapter(fetchImpl: typeof fetch, requestChanges = false) {
  return new GitHubAdapter({
    pullRequest: { owner: "o", repo: "r", number: 7 },
    api: new GitHubApi({ owner: "o", repo: "r" }, { token: "t", fetch: fetchImpl }),
    code,
    botLogin: "github-actions[bot]",
    requestChanges,
  });
}

function finding(
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

function report(
  findings: Finding[],
  verdict: ReviewReport["verdict"] = "approved_with_comments",
): ReviewReport {
  return {
    changeRequest: { id: "o/r#7", title: "t", description: "", baseSha: "base", headSha: "head" },
    tier: "lite",
    verdict,
    summary: "Summary.",
    coverage: [{ path: "src/login.ts", status: "reviewed" }],
    bundles: [],
    tasks: [],
    skipped: [],
    findings,
    refuted: [],
    usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, costUsd: 0.01 },
    warnings: [],
  };
}

function postedSummary(calls: Call[]): string {
  const post = calls.find((c) => c.method === "POST" && c.path === "/issues/7/comments");
  if (!post) throw new Error("no summary comment was posted");
  return (post.body as { body: string }).body;
}

const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";

describe("GitHubAdapter", () => {
  it("maps the pull request to a change request", async () => {
    const { fetchImpl } = fakeGitHub();
    expect(await adapter(fetchImpl).getChangeRequest()).toEqual({
      id: "o/r#7",
      title: "Add login",
      description: "",
      baseSha: "base",
      headSha: "head",
    });
  });

  it("comments inline on findings in the diff and summarizes the rest", async () => {
    const { calls, fetchImpl } = fakeGitHub();
    await adapter(fetchImpl).publish(report([finding(A, true), finding(B, false)]));

    const review = calls.find((c) => c.path === "/pulls/7/reviews");
    expect(review?.body).toMatchObject({
      commit_id: "head",
      event: "COMMENT",
      comments: [{ path: "src/login.ts", start_line: 3, line: 4, side: "RIGHT" }],
    });
    const body = postedSummary(calls);
    expect(body).toContain(SUMMARY_MARKER);
    expect(body).toContain("### Findings outside the diff");
    expect(body).toContain("@​here");
    expect(body).not.toContain("<img");
    expect(readState(body)).toEqual([
      {
        fingerprint: A,
        title: expect.any(String),
        file: "src/login.ts",
        severity: "warning",
        commented: true,
      },
      {
        fingerprint: B,
        title: expect.any(String),
        file: "src/login.ts",
        severity: "warning",
        commented: false,
      },
    ]);
  });

  it("updates its own summary and does not repeat inline comments", async () => {
    const previous = {
      id: 99,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: `${SUMMARY_MARKER}\n${writeState([{ fingerprint: A, title: "t", file: "src/login.ts", severity: "warning", commented: true }])}`,
    };
    const forged = { ...previous, id: 5, user: { login: "mallory", type: "User" } };
    const { calls, fetchImpl } = fakeGitHub([previous, forged]);
    const github = adapter(fetchImpl);

    expect((await github.getPriorReview())?.findings.map((f) => f.fingerprint)).toEqual([A]);
    await github.publish(report([finding(A, true)]));
    expect(calls.some((c) => c.path === "/pulls/7/reviews")).toBe(false);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.path)).toEqual([
      "/issues/comments/99",
    ]);
  });

  it("falls back to the summary when GitHub rejects inline positions", async () => {
    const { calls, fetchImpl } = fakeGitHub([], 422);
    await adapter(fetchImpl, true).publish(
      report([finding(A, true, "critical")], "significant_concerns"),
    );
    const reviews = calls.filter((c) => c.path === "/pulls/7/reviews");
    expect(reviews.map((c) => (c.body as { comments: unknown[] }).comments.length)).toEqual([1, 0]);
    expect(reviews[0]?.body).toMatchObject({ event: "REQUEST_CHANGES" });
    const body = postedSummary(calls);
    expect(readState(body)?.[0]?.commented).toBe(false);
  });

  it("ignores state it cannot trust", () => {
    expect(readState("<!-- ocra:state v1 bm90IGpzb24= -->")).toBeUndefined();
    expect(
      readState(
        `<!-- ocra:state v1 ${Buffer.from('{"findings":[{"fingerprint":"../x"}]}').toString("base64")} -->`,
      ),
    ).toBeUndefined();
  });
});
