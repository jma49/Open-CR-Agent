import type { FileProposal } from "@open-cr-agent/vcs-platform";
import { describe, expect, it } from "vitest";
import { proposeOnGitHub } from "./propose.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

const proposal: FileProposal = {
  branch: "ocra/learnings-20261121",
  title: "Add 1 learning from fix commits",
  body: "body",
  commitMessage: "chore(ocra): add learnings",
  files: [{ path: ".ocra/learnings/release.md", content: "---\ntitle: x\n---\n\nBody\n" }],
  autoMerge: true,
};

function github({
  repository = {},
  graphqlError,
  mergeStatus = 200,
}: {
  repository?: Record<string, unknown>;
  graphqlError?: string;
  mergeStatus?: number;
} = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.github.com/repos/o/r", "");
    const call: Call = { method: init?.method ?? "GET", path };
    if (init?.body) call.body = JSON.parse(init.body as string);
    calls.push(call);
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.endsWith("/graphql")) {
      return json(
        200,
        graphqlError ? { errors: [{ message: graphqlError }] } : { data: { x: null } },
      );
    }
    const answers: Record<string, () => Response> = {
      "GET ": () => json(200, { default_branch: "main", allow_auto_merge: true, ...repository }),
      "GET /git/ref/heads/main": () => json(200, { object: { sha: "h".repeat(40) } }),
      [`GET /git/commits/${"h".repeat(40)}`]: () => json(200, { tree: { sha: "t1" } }),
      "POST /git/trees": () => json(201, { sha: "t2" }),
      "POST /git/commits": () => json(201, { sha: "c".repeat(40) }),
      "POST /git/refs": () => json(201, {}),
      "POST /pulls": () =>
        json(201, { number: 9, node_id: "PR_9", html_url: "https://github.com/o/r/pull/9" }),
      "PUT /pulls/9/merge": () => json(mergeStatus, { message: "Protected branch" }),
    };
    const answer = answers[`${call.method} ${path}`];
    return answer ? answer() : json(404, { message: "Not Found" });
  }) as typeof fetch;
  const options = {
    env: { GITHUB_TOKEN: "ghs_secret", GITHUB_REPOSITORY: "o/r" },
    origin: async () => undefined,
    fetch: fetchImpl,
  };
  return { calls, options };
}

describe("proposeOnGitHub", () => {
  it("commits the files on a new branch from the default branch and opens a pull request", async () => {
    const { calls, options } = github();
    const proposed = await proposeOnGitHub(options, proposal);
    expect(proposed).toEqual({
      webUrl: "https://github.com/o/r/pull/9",
      merge: "enabled",
      warnings: [],
    });
    const body = (method: string, path: string) =>
      calls.find((c) => c.method === method && c.path === path)?.body;
    expect(body("POST", "/git/trees")).toEqual({
      base_tree: "t1",
      tree: [
        {
          path: proposal.files[0]?.path,
          mode: "100644",
          type: "blob",
          content: proposal.files[0]?.content,
        },
      ],
    });
    expect(body("POST", "/git/commits")).toEqual({
      message: "chore(ocra): add learnings",
      tree: "t2",
      parents: ["h".repeat(40)],
    });
    expect(body("POST", "/git/refs")).toEqual({
      ref: "refs/heads/ocra/learnings-20261121",
      sha: "c".repeat(40),
    });
    expect(body("POST", "/pulls")).toMatchObject({ head: proposal.branch, base: "main" });
    const graphql = calls.find((c) => c.path.endsWith("/graphql"))?.body as {
      variables: unknown;
    };
    expect(graphql.variables).toEqual({ id: "PR_9", method: "SQUASH" });
  });

  it("leaves the pull request for a person when review is required", async () => {
    const { calls, options } = github();
    const proposed = await proposeOnGitHub(options, { ...proposal, autoMerge: false });
    expect(proposed.merge).toBe("off");
    expect(calls.some((c) => c.path.endsWith("/graphql"))).toBe(false);
  });

  it("merges at once a pull request nothing is required of, with an allowed method", async () => {
    const { calls, options } = github({
      repository: { allow_squash_merge: false },
      graphqlError: "Pull request Pull request is in clean status",
    });
    expect((await proposeOnGitHub(options, proposal)).merge).toBe("merged");
    expect(calls.at(-1)).toEqual({
      method: "PUT",
      path: "/pulls/9/merge",
      body: { merge_method: "rebase" },
    });
  });

  it("says why it leaves the pull request open", async () => {
    const off = github({ repository: { allow_auto_merge: false } });
    expect(await proposeOnGitHub(off.options, proposal)).toMatchObject({
      merge: "unavailable",
      warnings: [expect.stringContaining("auto-merge is off")],
    });
    const refused = github({ graphqlError: "Resource not accessible by integration" });
    expect(await proposeOnGitHub(refused.options, proposal)).toMatchObject({
      merge: "unavailable",
      warnings: [expect.stringContaining("Resource not accessible")],
    });
    const protectedBranch = github({ graphqlError: "is in clean status", mergeStatus: 405 });
    expect((await proposeOnGitHub(protectedBranch.options, proposal)).merge).toBe("unavailable");
  });

  it("needs a token", async () => {
    const { options } = github();
    await expect(proposeOnGitHub({ ...options, env: {} }, proposal)).rejects.toThrow(
      "--propose needs a GitHub token",
    );
  });
});
