import type { FileProposal } from "@open-cr-agent/vcs-platform";
import { describe, expect, it } from "vitest";
import { proposeOnGitLab } from "./propose.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

const API = "https://gitlab.example.com/api/v4/projects/g%2Fp";
const MR_URL = "https://gitlab.example.com/g/p/-/merge_requests/4";

const proposal: FileProposal = {
  branch: "ocra/learnings-20261121",
  title: "chore(ocra): add 2 learning(s) from fix commits",
  body: "body",
  commitMessage: "chore(ocra): add 2 learning(s) from fix commits",
  files: [
    { path: ".ocra/learnings/release.md", content: "---\ntitle: x\n---\n\nBody\n" },
    { path: ".ocra/learnings/retry.md", content: "---\ntitle: y\n---\n\nBody\n" },
  ],
  autoMerge: true,
};

interface Script {
  tree?: number | { path: string; type: string }[];
  // The merge request each GET answers, in turn; the last one repeats.
  states?: Record<string, unknown>[];
  // The merge call's answers, in turn: a status with a message, or a body.
  merges?: {
    status?: number;
    message?: string;
    state?: string;
    merge_when_pipeline_succeeds?: boolean;
  }[];
}

function gitlab(script: Script = {}) {
  const calls: Call[] = [];
  const states = [
    ...(script.states ?? [{ merge_status: "can_be_merged", head_pipeline: { id: 1 } }]),
  ];
  const merges = [...(script.merges ?? [{ state: "opened", merge_when_pipeline_succeeds: true }])];
  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = url.replace(API, "");
    const call: Call = { method: init?.method ?? "GET", path };
    if (init?.body) call.body = JSON.parse(init.body as string);
    calls.push(call);
    const mr = { iid: 4, web_url: MR_URL };
    if (call.method === "GET" && path === "") return json(200, { default_branch: "main" });
    if (call.method === "GET" && path.startsWith("/repository/tree?")) {
      const tree = script.tree ?? [];
      return typeof tree === "number"
        ? json(tree, { message: "404 Tree Not Found" })
        : json(200, tree);
    }
    if (call.method === "POST" && path === "/repository/commits") return json(201, { id: "c" });
    if (call.method === "POST" && path === "/merge_requests") return json(201, mr);
    if (call.method === "GET" && path === "/merge_requests/4") {
      return json(200, { ...mr, ...(states.length > 1 ? states.shift() : states[0]) });
    }
    if (call.method === "PUT" && path === "/merge_requests/4/merge") {
      const answer = merges.length > 1 ? merges.shift() : merges[0];
      return typeof answer?.status === "number"
        ? json(answer.status, { message: answer.message })
        : json(200, { ...mr, ...answer });
    }
    return json(404, { message: "404 Not Found" });
  }) as typeof fetch;
  const slept: number[] = [];
  const options = {
    env: { GITLAB_TOKEN: "glpat-secret", CI_API_V4_URL: "https://gitlab.example.com/api/v4" },
    repository: "g/p",
    origin: async () => "git@gitlab.example.com:g/p.git",
    fetch: fetchImpl,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
  return { calls, options, slept };
}

describe("proposeOnGitLab", () => {
  it("commits the files on a new branch, opens a merge request and sets it to merge when its pipeline succeeds", async () => {
    const { calls, options } = gitlab({
      tree: [{ path: ".ocra/learnings/retry.md", type: "blob" }],
    });
    expect(await proposeOnGitLab(options, proposal)).toEqual({
      webUrl: MR_URL,
      merge: "enabled",
      warnings: [],
    });
    const body = (method: string, path: string) =>
      calls.find((c) => c.method === method && c.path === path)?.body;
    expect(body("POST", "/repository/commits")).toEqual({
      branch: proposal.branch,
      start_branch: "main",
      commit_message: proposal.commitMessage,
      actions: [
        {
          action: "create",
          file_path: ".ocra/learnings/release.md",
          content: proposal.files[0]?.content,
        },
        {
          action: "update",
          file_path: ".ocra/learnings/retry.md",
          content: proposal.files[1]?.content,
        },
      ],
    });
    expect(body("POST", "/merge_requests")).toEqual({
      source_branch: proposal.branch,
      target_branch: "main",
      title: proposal.title,
      description: "body",
      remove_source_branch: true,
    });
    expect(body("PUT", "/merge_requests/4/merge")).toEqual({
      merge_when_pipeline_succeeds: true,
      should_remove_source_branch: true,
    });
    expect(calls.filter((c) => c.path.startsWith("/repository/tree"))).toHaveLength(1);
  });

  it("creates every file when the branch has no learnings directory yet", async () => {
    const { calls, options } = gitlab({ tree: 404 });
    await proposeOnGitLab(options, proposal);
    const commit = calls.find((c) => c.path === "/repository/commits")?.body as {
      actions: { action: string }[];
    };
    expect(commit.actions.map((a) => a.action)).toEqual(["create", "create"]);
  });

  it("waits for the pipeline a new branch starts before asking to merge", async () => {
    const { calls, options, slept } = gitlab({
      states: [
        { merge_status: "checking", head_pipeline: null },
        { merge_status: "can_be_merged", head_pipeline: null },
        { merge_status: "can_be_merged", head_pipeline: { id: 3 } },
      ],
    });
    expect((await proposeOnGitLab(options, proposal)).merge).toBe("enabled");
    expect(slept).toEqual([1000, 2000]);
    const order = calls.map((c) => `${c.method} ${c.path}`).slice(-4);
    expect(order).toEqual([
      "GET /merge_requests/4",
      "GET /merge_requests/4",
      "GET /merge_requests/4",
      "PUT /merge_requests/4/merge",
    ]);
  });

  it("merges at once a merge request with no pipeline after the waits", async () => {
    const { options, slept } = gitlab({
      states: [{ merge_status: "can_be_merged", head_pipeline: null }],
      merges: [{ state: "merged" }],
    });
    expect((await proposeOnGitLab(options, proposal)).merge).toBe("merged");
    expect(slept).toHaveLength(5);
  });

  it("asks again while GitLab is still checking whether it can be merged", async () => {
    const { options } = gitlab({
      states: [
        { merge_status: "checking", head_pipeline: { id: 1 } },
        { merge_status: "checking", head_pipeline: { id: 1 } },
        { merge_status: "checking", head_pipeline: { id: 1 } },
        { merge_status: "checking", head_pipeline: { id: 1 } },
        { merge_status: "checking", head_pipeline: { id: 1 } },
        { merge_status: "checking", head_pipeline: { id: 1 } },
        { merge_status: "can_be_merged", head_pipeline: { id: 1 } },
      ],
      merges: [
        { status: 405, message: "Method Not Allowed" },
        { state: "opened", merge_when_pipeline_succeeds: true },
      ],
    });
    expect((await proposeOnGitLab(options, proposal)).merge).toBe("enabled");
  });

  it("leaves the merge request for a person when review is required", async () => {
    const { calls, options } = gitlab();
    const proposed = await proposeOnGitLab(options, { ...proposal, autoMerge: false });
    expect(proposed.merge).toBe("off");
    expect(calls.some((c) => c.path.startsWith("/merge_requests/4"))).toBe(false);
  });

  it("says why it leaves the merge request open", async () => {
    const refused = gitlab({ merges: [{ status: 401, message: "401 Unauthorized" }] });
    expect(await proposeOnGitLab(refused.options, proposal)).toMatchObject({
      merge: "unavailable",
      warnings: [expect.stringContaining("401 Unauthorized")],
    });
    const blocked = gitlab({ merges: [{ status: 405, message: "405 Method Not Allowed" }] });
    expect((await proposeOnGitLab(blocked.options, proposal)).merge).toBe("unavailable");
  });

  it("needs a token, and never puts it in what it returns", async () => {
    const { options } = gitlab();
    await expect(proposeOnGitLab({ ...options, env: {} }, proposal)).rejects.toThrow(
      "--propose needs a GitLab token",
    );
    expect(JSON.stringify(await proposeOnGitLab(options, proposal))).not.toContain("glpat-secret");
  });
});
