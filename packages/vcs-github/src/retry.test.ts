import { describe, expect, it } from "vitest";
import { GitHubApi, GitHubApiError } from "./client.js";
import { retryDecision } from "./retry.js";

function api(responses: (Response | Error)[]) {
  const calls: string[] = [];
  const waits: number[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls.push(init?.method ?? "GET");
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  const client = new GitHubApi(
    { owner: "o", repo: "r" },
    {
      token: "t",
      fetch: fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  return { client, calls, waits };
}

const ok = () => new Response("[]", { status: 200 });
const status = (code: number, headers: Record<string, string> = {}, body = "") =>
  new Response(body, { status: code, headers });

describe("GitHubApi retries", () => {
  it("retries reads through outages and connection errors", async () => {
    const { client, calls } = api([status(502), new TypeError("fetch failed"), ok()]);
    expect(await client.listIssueComments(7)).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("gives up after three attempts", async () => {
    const { client, calls } = api([status(503), status(503), status(503), ok()]);
    await expect(client.listIssueComments(7)).rejects.toBeInstanceOf(GitHubApiError);
    expect(calls).toHaveLength(3);
  });

  it("never repeats a POST that GitHub may have acted on", async () => {
    const { client, calls } = api([status(502), ok()]);
    await expect(client.createIssueComment(7, "hi")).rejects.toThrow("failed with 502");
    expect(calls).toEqual(["POST"]);
  });

  it("repeats a POST that GitHub refused for its rate limit, waiting as told", async () => {
    const { client, calls, waits } = api([
      status(403, { "retry-after": "7" }, "You have exceeded a secondary rate limit"),
      status(429, { "x-ratelimit-reset": "1000" }),
      new Response("{}", { status: 201 }),
    ]);
    await client.createIssueComment(7, "hi");
    expect(calls).toEqual(["POST", "POST", "POST"]);
    expect(waits[0]).toBe(7_000);
  });

  it("does not retry a plain 403", () => {
    expect(
      retryDecision("GET", true, { status: 403, headers: new Headers(), body: "Forbidden" }, 1)
        .retry,
    ).toBe(false);
  });

  it("caps the wait for a rate limit reset", () => {
    const headers = new Headers({ "x-ratelimit-reset": "5000" });
    expect(retryDecision("GET", true, { status: 429, headers, body: "" }, 1, 0).waitMs).toBe(
      60_000,
    );
  });
});
