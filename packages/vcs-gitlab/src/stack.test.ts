import { describe, expect, it } from "vitest";
import { gitlabStackHost } from "./stack.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

const API = "https://gitlab.example.com/api/v4/projects/g%2Fp";

const request = (over: Record<string, unknown>) => ({
  iid: 4,
  state: "opened",
  title: "feat: a",
  description: null,
  web_url: "https://gitlab.example.com/g/p/-/merge_requests/4",
  source_branch: "feat/a",
  target_branch: "main",
  ...over,
});

function gitlab(listed: unknown[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", path: url.replace(API, "") };
    if (init?.body) call.body = JSON.parse(init.body as string);
    calls.push(call);
    const value = call.method === "GET" ? listed : request({ iid: 5, source_branch: "feat/b" });
    return new Response(JSON.stringify(value), {
      status: call.method === "POST" ? 201 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const options = {
    env: { GITLAB_TOKEN: "glpat-secret", CI_API_V4_URL: "https://gitlab.example.com/api/v4" },
    repository: "g/p",
    origin: async () => "git@gitlab.example.com:g/p.git",
    fetch: fetchImpl,
  };
  return { calls, options };
}

describe("gitlabStackHost", () => {
  it("finds the open merge request from a branch before a merged one", async () => {
    const { calls, options } = gitlab([request({ iid: 2, state: "merged" }), request({})]);
    const found = await (await gitlabStackHost(options, () => {})).find("feat/a");
    expect(found).toMatchObject({ number: 4, state: "open", head: "feat/a", base: "main" });
    expect(calls[0]?.path).toBe("/merge_requests?source_branch=feat%2Fa&per_page=20");
  });

  it("opens a draft merge request on its parent and retargets one", async () => {
    const { calls, options } = gitlab([]);
    const host = await gitlabStackHost(options, () => {});
    await host.open({ head: "feat/b", base: "feat/a", title: "feat: b", body: "x", draft: true });
    await host.update(5, { base: "main" });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/merge_requests",
        body: {
          source_branch: "feat/b",
          target_branch: "feat/a",
          title: "Draft: feat: b",
          description: "x",
          remove_source_branch: true,
        },
      },
      { method: "PUT", path: "/merge_requests/5", body: { target_branch: "main" } },
    ]);
  });
});
