import { describe, expect, it } from "vitest";
import { githubChecks, githubFailingOnBase } from "./checks.js";
import { GitHubApi } from "./client.js";

const HEAD = "a".repeat(40);

type Answer = { status?: number; json?: unknown; text?: string };

function github(answers: Record<string, Answer>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const path = url.replace("https://api.github.com/repos/o/r", "");
    calls.push(path);
    const answer = answers[path] ?? { status: 404, json: { message: "Not Found" } };
    return answer.text !== undefined
      ? new Response(answer.text, { status: answer.status ?? 200 })
      : Response.json(answer.json, { status: answer.status ?? 200 });
  }) as typeof fetch;
  const api = new GitHubApi({ owner: "o", repo: "r" }, { token: "t", fetch: fetchImpl });
  return { api, calls };
}

const run = (id: number, name: string, status: string, conclusion: string | null, more = {}) => ({
  id,
  name,
  status,
  conclusion,
  app: { slug: "github-actions" },
  output: { title: null, summary: null, text: null },
  ...more,
});
const runsAt = (ref: string) => `/commits/${ref}/check-runs?filter=latest&per_page=100&page=1`;

describe("githubChecks", () => {
  it("reads each check run's state, and counts only a failure or a timeout as failed", async () => {
    const { api } = github({
      [runsAt(HEAD)]: {
        json: {
          check_runs: [
            run(1, "test", "completed", "failure"),
            run(2, "e2e", "completed", "timed_out"),
            run(3, "lint", "completed", "success"),
            run(4, "deploy", "completed", "cancelled"),
            run(5, "docs", "completed", "skipped"),
            run(6, "build", "in_progress", null),
          ],
        },
      },
    });
    const checks = await githubChecks(api, HEAD);
    expect(checks.map((c) => [c.name, c.state])).toEqual([
      ["test", "failed"],
      ["e2e", "failed"],
      ["lint", "passed"],
      ["deploy", "passed"],
      ["docs", "passed"],
      ["build", "pending"],
    ]);
  });

  it("reads an Actions job's log, and what another app's check reported", async () => {
    const { api, calls } = github({
      [runsAt(HEAD)]: {
        json: {
          check_runs: [
            run(11, "test", "completed", "failure"),
            run(12, "scan", "completed", "failure", {
              app: { slug: "some-scanner" },
              output: { title: "2 problems", summary: "src/a.ts: unused", text: null },
            }),
          ],
        },
      },
      "/actions/jobs/11/logs": { text: "FAIL src/a.test.ts\n" },
    });
    const [test, scan] = await githubChecks(api, HEAD);
    expect(await test?.log()).toBe("FAIL src/a.test.ts\n");
    expect(await scan?.log()).toBe("2 problems\nsrc/a.ts: unused");
    expect(calls).not.toContain("/actions/jobs/12/logs");
  });

  it("falls back to the check's own report when the token may not read the log", async () => {
    const { api } = github({
      [runsAt(HEAD)]: {
        json: {
          check_runs: [
            run(11, "test", "completed", "failure", {
              output: { title: "Tests failed", summary: null, text: null },
            }),
            run(12, "build", "completed", "failure"),
          ],
        },
      },
      "/actions/jobs/11/logs": { status: 403, json: { message: "Resource not accessible" } },
    });
    const [test, build] = await githubChecks(api, HEAD);
    expect(await test?.log()).toBe("Tests failed");
    expect(await build?.log()).toBe("");
  });
});

describe("githubFailingOnBase", () => {
  it("names the checks that fail on the head of the pull request's base branch", async () => {
    const { api, calls } = github({
      "/pulls/7": { json: { base: { ref: "release/1.x" } } },
      [runsAt("heads/release/1.x")]: {
        json: {
          check_runs: [
            run(1, "flaky", "completed", "failure"),
            run(2, "test", "completed", "success"),
          ],
        },
      },
    });
    expect(await githubFailingOnBase(api, 7)).toEqual(["flaky"]);
    expect(calls).toEqual(["/pulls/7", runsAt("heads/release/1.x")]);
  });
});
