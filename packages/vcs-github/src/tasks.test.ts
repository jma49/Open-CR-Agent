import { describe, expect, it } from "vitest";
import { GitHubApi } from "./client.js";
import { githubLinkedTasks } from "./tasks.js";

const PR = { owner: "o", repo: "r", number: 7 };

const issue = (number: number, repository = "o/r") => ({
  number,
  title: `Issue ${number}`,
  body: null,
  state: "OPEN",
  url: `https://github.com/${repository}/issues/${number}`,
  repository: { nameWithOwner: repository },
  labels: { nodes: [{ name: "bug" }] },
  parent: { number: 1, title: "Epic", body: "The goal" },
  subIssues: { nodes: [{ number: number + 100, title: "Part", state: "CLOSED" }] },
});

// Answers the closing-issues query, then the issue-by-branch query.
function api(closing: unknown[], headRefName: string, byNumber?: Record<number, unknown>) {
  const queries: { query: string; variables: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string);
    queries.push(body);
    const data = body.query.includes("closingIssuesReferences")
      ? {
          repository: { pullRequest: { headRefName, closingIssuesReferences: { nodes: closing } } },
        }
      : { repository: { issueOrPullRequest: byNumber?.[body.variables.number] ?? null } };
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    queries,
    api: new GitHubApi(PR, { token: "t", fetch: fetchImpl, sleep: async () => {} }),
  };
}

describe("githubLinkedTasks", () => {
  it("returns the pull request's closing issues with parent and sub-issues", async () => {
    const { api: client } = api([issue(12)], "main");
    expect(await githubLinkedTasks(client, PR)).toEqual([
      {
        tracker: "github",
        key: "#12",
        url: "https://github.com/o/r/issues/12",
        title: "Issue 12",
        state: "open",
        labels: ["bug"],
        body: "",
        parent: { key: "#1", title: "Epic", body: "The goal" },
        subtasks: [{ key: "#112", title: "Part", state: "closed" }],
      },
    ]);
  });

  it("leaves out another repository's issue, which a fork's author could name", async () => {
    const { api: client } = api([issue(3, "o/private"), issue(12)], "main");
    expect((await githubLinkedTasks(client, PR)).map((t) => t.key)).toEqual(["#12"]);
  });

  it("falls back to the issue the head branch is named after", async () => {
    const { api: client, queries } = api([issue(5, "other/repo")], "42-fix-login", {
      42: issue(42),
    });
    expect((await githubLinkedTasks(client, PR)).map((t) => t.key)).toEqual(["#42"]);
    expect(queries[1]?.variables).toEqual({ owner: "o", repo: "r", number: 42 });
  });

  it("finds none when the branch names a pull request or no number", async () => {
    expect(await githubLinkedTasks(api([], "9-x", { 9: {} }).api, PR)).toEqual([]);
    const plain = api([], "feature/login");
    expect(await githubLinkedTasks(plain.api, PR)).toEqual([]);
    expect(plain.queries).toHaveLength(1);
  });
});
