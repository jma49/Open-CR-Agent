import { describe, expect, it } from "vitest";
import { githubStackHost } from "./stack.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

const pull = (over: Record<string, unknown>) => ({
  number: 7,
  state: "open",
  merged_at: null,
  title: "feat: a",
  body: null,
  html_url: "https://github.com/o/r/pull/7",
  head: { ref: "feat/a" },
  base: { ref: "main" },
  ...over,
});

function github(listed: unknown[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.github.com/repos/o/r", "");
    const call: Call = { method: init?.method ?? "GET", path };
    if (init?.body) call.body = JSON.parse(init.body as string);
    calls.push(call);
    const value = call.method === "GET" ? listed : pull({ number: 8, head: { ref: "feat/b" } });
    return new Response(JSON.stringify(value), {
      status: call.method === "POST" ? 201 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const options = {
    env: { GITHUB_TOKEN: "ghs_secret", GITHUB_REPOSITORY: "o/r" },
    origin: async () => undefined,
    fetch: fetchImpl,
  };
  return { calls, options };
}

describe("githubStackHost", () => {
  it("finds the open pull request from a branch of the repository before a merged one", async () => {
    const { calls, options } = github([
      pull({ number: 3, state: "closed", merged_at: "2026-11-01T00:00:00Z" }),
      pull({ number: 7 }),
    ]);
    const found = await (await githubStackHost(options)).find("feat/a");
    expect(found).toMatchObject({
      number: 7,
      state: "open",
      head: "feat/a",
      base: "main",
      body: "",
    });
    expect(calls[0]?.path).toBe("/pulls?head=o%3Afeat%2Fa&state=all&per_page=20");
  });

  it("reads a closed pull request with a merge time as merged and ignores one without", async () => {
    const merged = github([pull({ state: "closed", merged_at: "2026-11-01T00:00:00Z" })]);
    expect((await (await githubStackHost(merged.options)).find("feat/a"))?.state).toBe("merged");
    const closed = github([pull({ state: "closed" })]);
    expect(await (await githubStackHost(closed.options)).find("feat/a")).toBeUndefined();
  });

  it("opens a pull request on its parent and retargets one", async () => {
    const { calls, options } = github([]);
    const host = await githubStackHost(options);
    const opened = await host.open({
      head: "feat/b",
      base: "feat/a",
      title: "feat: b",
      body: "x",
      draft: true,
    });
    await host.update(8, { base: "main", body: "y" });
    expect(opened.number).toBe(8);
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/pulls",
        body: { head: "feat/b", base: "feat/a", title: "feat: b", body: "x", draft: true },
      },
      { method: "PATCH", path: "/pulls/8", body: { base: "main", body: "y" } },
    ]);
  });
});
