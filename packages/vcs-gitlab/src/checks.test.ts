import { describe, expect, it } from "vitest";
import { gitlabChecks, gitlabFailingOnBase } from "./checks.js";
import { GitLabApi } from "./client.js";

const API = "https://gitlab.example.com/api/v4/projects/g%2Fp";
const HEAD = "a".repeat(40);

type Answer = { status?: number; json?: unknown; text?: string };

function gitlab(answers: Record<string, Answer>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const path = url.replace(API, "");
    calls.push(path);
    const answer = answers[path] ?? { status: 404, json: { message: "404 Not Found" } };
    return answer.text !== undefined
      ? new Response(answer.text, { status: answer.status ?? 200 })
      : Response.json(answer.json, { status: answer.status ?? 200 });
  }) as typeof fetch;
  const api = new GitLabApi("g/p", {
    token: "t",
    baseUrl: "https://gitlab.example.com/api/v4",
    fetch: fetchImpl,
  });
  return { api, calls };
}

const jobsOf = (pipeline: number) => `/pipelines/${pipeline}/jobs?per_page=100&page=1`;
const PIPELINES = "/merge_requests/4/pipelines?per_page=100";

describe("gitlabChecks", () => {
  it("reads the jobs of the merge request's newest pipeline on the head", async () => {
    const { api } = gitlab({
      [PIPELINES]: {
        json: [
          { id: 31, sha: "b".repeat(40) },
          { id: 30, sha: HEAD },
          { id: 29, sha: HEAD },
        ],
      },
      [jobsOf(30)]: {
        json: [
          { id: 1, name: "test", status: "failed", allow_failure: false },
          { id: 2, name: "audit", status: "failed", allow_failure: true },
          { id: 3, name: "lint", status: "success" },
          { id: 4, name: "build", status: "running" },
          { id: 5, name: "deploy", status: "manual" },
          { id: 6, name: "e2e", status: "canceled" },
        ],
      },
      "/jobs/1/trace": { text: "FAIL src/a.test.ts\n" },
    });
    const checks = await gitlabChecks(api, 4, HEAD);
    expect(checks.map((c) => [c.name, c.state])).toEqual([
      ["test", "failed"],
      ["audit", "passed"],
      ["lint", "passed"],
      ["build", "pending"],
      ["deploy", "passed"],
      ["e2e", "passed"],
    ]);
    expect(await checks[0]?.log()).toBe("FAIL src/a.test.ts\n");
  });

  it("has no checks without a pipeline on the head, and an empty log it may not read", async () => {
    const none = gitlab({ [PIPELINES]: { json: [{ id: 31, sha: "b".repeat(40) }] } });
    expect(await gitlabChecks(none.api, 4, HEAD)).toEqual([]);

    const { api } = gitlab({
      [PIPELINES]: { json: [{ id: 30, sha: HEAD }] },
      [jobsOf(30)]: { json: [{ id: 1, name: "test", status: "failed" }] },
      "/jobs/1/trace": { status: 403, json: { message: "403 Forbidden" } },
    });
    const [test] = await gitlabChecks(api, 4, HEAD);
    expect(await test?.log()).toBe("");
  });
});

describe("gitlabFailingOnBase", () => {
  it("names the jobs that fail in the target branch's latest pipeline", async () => {
    const { api } = gitlab({
      "/merge_requests/4": { json: { target_branch: "release/1.x" } },
      "/pipelines?ref=release%2F1.x&per_page=1": { json: [{ id: 20, sha: "d".repeat(40) }] },
      [jobsOf(20)]: {
        json: [
          { id: 7, name: "flaky", status: "failed" },
          { id: 8, name: "test", status: "success" },
        ],
      },
    });
    expect(await gitlabFailingOnBase(api, 4)).toEqual(["flaky"]);
  });

  it("names none when the target branch has no pipeline", async () => {
    const { api } = gitlab({
      "/merge_requests/4": { json: { target_branch: "main" } },
      "/pipelines?ref=main&per_page=1": { json: [] },
    });
    expect(await gitlabFailingOnBase(api, 4)).toEqual([]);
  });
});
