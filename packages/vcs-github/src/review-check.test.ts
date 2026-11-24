import { describe, expect, it } from "vitest";
import { type Call, code, finding, report } from "./adapter.fakes.js";
import { GitHubAdapter } from "./adapter.js";
import { GitHubApi } from "./client.js";

const HEAD = "c".repeat(40);

function fakeChecks(checkStatus = 201) {
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
    if (path.startsWith("/check-runs")) {
      return checkStatus >= 400
        ? json(checkStatus, { message: "Resource not accessible by integration" })
        : json(checkStatus, { id: 42 });
    }
    if (url.endsWith("/graphql")) {
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        },
      });
    }
    if (method === "GET" && /\/(comments|reviews|files)\b/.test(path)) return json(200, []);
    return json(201, {});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function github(fetchImpl: typeof fetch, checkRunId?: number) {
  return new GitHubAdapter({
    pullRequest: { owner: "o", repo: "r", number: 7 },
    api: new GitHubApi(
      { owner: "o", repo: "r" },
      { token: "t", fetch: fetchImpl, sleep: async () => {} },
    ),
    code,
    botLogin: "github-actions[bot]",
    snapshot: { id: "o/r#7", title: "t", description: "", baseSha: "b".repeat(40), headSha: HEAD },
    ...(checkRunId ? { checkRunId } : {}),
  });
}

const checkCalls = (calls: Call[]) => calls.filter((c) => c.path.startsWith("/check-runs"));

describe("the ocra review check", () => {
  it("runs from in progress on the head to the review's verdict", async () => {
    const { calls, fetchImpl } = fakeChecks();
    const vcs = github(fetchImpl);
    expect(await vcs.started()).toEqual({ warnings: [] });
    const { warnings } = await vcs.publish(report([finding("a".repeat(16), true)]));
    expect(warnings).toEqual([]);
    const [start, end] = checkCalls(calls);
    expect(start).toMatchObject({
      method: "POST",
      path: "/check-runs",
      body: { name: "ocra review", head_sha: HEAD, status: "in_progress" },
    });
    expect(end).toMatchObject({
      method: "PATCH",
      path: "/check-runs/42",
      body: {
        status: "completed",
        conclusion: "success",
        output: { title: "Approved with comments · 1 warning" },
      },
    });
  });

  it("takes over the check ocra Cloud queued instead of adding one", async () => {
    const { calls, fetchImpl } = fakeChecks(200);
    const vcs = github(fetchImpl, 9);
    await vcs.started();
    await vcs.stopped("The review was interrupted before it finished.");
    expect(checkCalls(calls).map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /check-runs/9",
      "PATCH /check-runs/9",
    ]);
    expect(checkCalls(calls)[1]?.body).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
  });

  it("warns once when the token may not write checks, and still publishes", async () => {
    const { calls, fetchImpl } = fakeChecks(403);
    const vcs = github(fetchImpl);
    expect(await vcs.started()).toEqual({
      warnings: ["could not show the review's check: the token needs the checks: write permission"],
    });
    expect((await vcs.publish(report([]))).warnings).toEqual([]);
    expect(checkCalls(calls)).toHaveLength(1);
    expect(calls.some((c) => c.method === "POST" && c.path === "/issues/7/comments")).toBe(true);
  });

  it("ends the check when publishing fails, then rethrows", async () => {
    const { fetchImpl: base, calls } = fakeChecks();
    const failing = (async (url: string, init?: RequestInit) =>
      url.endsWith("/issues/7/comments") && init?.method === "POST"
        ? new Response(JSON.stringify({ message: "boom" }), { status: 500 })
        : base(url, init)) as typeof fetch;
    const vcs = github(failing);
    await vcs.started();
    await expect(vcs.publish(report([]))).rejects.toThrow();
    const end = checkCalls(calls).at(-1);
    expect(end).toMatchObject({
      method: "PATCH",
      body: {
        conclusion: "cancelled",
        output: { summary: expect.stringMatching(/^Publishing failed: /) },
      },
    });
  });
});
