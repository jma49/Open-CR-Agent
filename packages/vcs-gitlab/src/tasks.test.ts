import { describe, expect, it } from "vitest";
import { GitLabApi } from "./client.js";
import { gitlabLinkedTasks } from "./tasks.js";

const API = "https://gitlab.example.com/api/v4";
const PROJECT = 10;

const issue = (iid: number, projectId = PROJECT) => ({
  iid,
  project_id: projectId,
  title: `Issue ${iid}`,
  description: null,
  state: "opened",
  labels: ["backend"],
  web_url: `https://gitlab.example.com/group/project/-/issues/${iid}`,
  epic: { iid: 2, title: "Payments" },
});

function api(closing: unknown[], sourceBranch: string, issues: Record<number, unknown> = {}) {
  const paths: string[] = [];
  const fetchImpl = (async (url: string) => {
    const path = url.replace(`${API}/projects/group%2Fproject`, "");
    paths.push(path);
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (path === "/merge_requests/7") {
      return json(200, {
        iid: 7,
        title: "t",
        description: null,
        author: null,
        web_url: "https://gitlab.example.com/group/project/-/merge_requests/7",
        source_project_id: 99,
        target_project_id: PROJECT,
        source_branch: sourceBranch,
        diff_refs: null,
      });
    }
    if (path.startsWith("/merge_requests/7/closes_issues")) return json(200, closing);
    const iid = Number(/^\/issues\/(\d+)$/.exec(path)?.[1]);
    const found = issues[iid];
    return found ? json(200, found) : json(404, { message: "404 Not found" });
  }) as typeof fetch;
  return {
    paths,
    api: new GitLabApi("group/project", {
      token: "glpat-secret",
      baseUrl: API,
      fetch: fetchImpl,
      sleep: async () => {},
    }),
  };
}

describe("gitlabLinkedTasks", () => {
  it("returns the issues the merge request closes, with their epic", async () => {
    expect(await gitlabLinkedTasks(api([issue(12)], "main").api, 7)).toEqual([
      {
        tracker: "gitlab",
        key: "#12",
        url: "https://gitlab.example.com/group/project/-/issues/12",
        title: "Issue 12",
        state: "open",
        labels: ["backend"],
        body: "",
        parent: { key: "&2", title: "Payments", body: "" },
        subtasks: [],
      },
    ]);
  });

  it("leaves out another project's issue, which a fork's author could name", async () => {
    const { api: client } = api([issue(3, 55), issue(12)], "main");
    expect((await gitlabLinkedTasks(client, 7)).map((t) => t.key)).toEqual(["#12"]);
  });

  it("falls back to the issue the source branch is named after", async () => {
    const { api: client } = api([], "42-fix-login", { 42: issue(42) });
    expect((await gitlabLinkedTasks(client, 7)).map((t) => t.key)).toEqual(["#42"]);
  });

  it("finds none when no issue has the branch's number", async () => {
    expect(await gitlabLinkedTasks(api([], "8-missing").api, 7)).toEqual([]);
    const plain = api([], "feature/login");
    expect(await gitlabLinkedTasks(plain.api, 7)).toEqual([]);
    expect(plain.paths.some((p) => p.startsWith("/issues/"))).toBe(false);
  });
});
