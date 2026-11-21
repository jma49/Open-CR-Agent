import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompletionRequest, OcraPlugin } from "@open-cr-agent/core";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { capture, deps } from "../run.fakes.js";
import { run } from "../run.js";
import type { ReviewDeps } from "./review/deps.js";

const repos = scratchRepos("ocra-learn-");
afterEach(repos.removeAll);

const lesson = {
  title: "Release pooled connections on every exit path",
  body: "Every `pool.acquire()` needs a `release()` in a `finally`.",
  symbols: ["acquire"],
  keywords: ["connection pool"],
};

function repoWithFix() {
  const repo = repos.create();
  repo.commit("feat(db): query helper", {
    "src/db/query.ts":
      "export async function query(sql) {\n  const conn = await pool.acquire();\n  return conn.run(sql);\n}\n",
  });
  repo.commit("fix(db): release the connection when a query throws", {
    "src/db/query.ts":
      "export async function query(sql) {\n  const conn = await pool.acquire();\n  try {\n    return await conn.run(sql);\n  } finally {\n    conn.release();\n  }\n}\n",
  });
  repo.commit("docs: explain the pool", { "README.md": "pool\n" });
  return repo;
}

function withDrafts(cwd: string, seen: CompletionRequest[], extra: Partial<ReviewDeps> = {}) {
  const runtime: OcraPlugin = {
    name: "runtime-opencode",
    configure(ctx) {
      ctx.registerRuntime("opencode", () => ({
        name: "fake",
        runTask: () => {
          throw new Error("learn runs no review task");
        },
        complete: async (request) => {
          seen.push(request);
          return {
            text: JSON.stringify(lesson),
            usage: {
              inputTokens: 9,
              outputTokens: 3,
              reasoningTokens: 0,
              cachedTokens: 0,
              costUsd: 0.25,
            },
          };
        },
      }));
    },
  };
  return deps(cwd, async function* () {}, {
    runtimes: { opencode: async () => runtime },
    ...extra,
  });
}

async function learn(
  cwd: string,
  seen: CompletionRequest[],
  args: string[] = [],
  extra: Partial<ReviewDeps> = {},
) {
  const out = capture();
  const err = capture();
  const code = await run(["learn", "mine", ...args], out, err, withDrafts(cwd, seen, extra));
  return { code, out: out.text(), err: err.text() };
}

describe("ocra learn mine", () => {
  it("drafts a learning from each fix commit and writes it to the working tree", async () => {
    const repo = repoWithFix();
    const seen: CompletionRequest[] = [];
    const result = await learn(repo.dir, seen);
    expect(result.code).toBe(0);
    const path = ".ocra/learnings/release-pooled-connections-on-every-exit-path.md";
    expect(result.out).toBe(`${path}\n`);
    expect(result.err).toContain("1 learning(s) kept from 1 draft(s); $0.2500");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.user).toContain("fix(db): release the connection when a query throws");
    const text = readFileSync(join(repo.dir, path), "utf8");
    expect(text).toContain("paths:\n  - src/db/**\n");
    expect(text).toContain(`ref: ${repo.git("rev-parse", "HEAD~1")}`);
    expect(readdirSync(join(repo.dir, ".ocra"))).toEqual(["learnings"]);
  });

  it("skips a fix a learning in the working tree already records", async () => {
    const repo = repoWithFix();
    await learn(repo.dir, []);
    const seen: CompletionRequest[] = [];
    const again = await learn(repo.dir, seen);
    expect(seen).toEqual([]);
    expect(again.out).toBe("");
    expect(again.err).toContain("1 already recorded");
  });

  it("drafts nothing once the spend limit is used up", async () => {
    const repo = repoWithFix();
    repo.commit("fix(api): handle an empty body", { "src/api/body.ts": "export const x = 1;\n" });
    const seen: CompletionRequest[] = [];
    const result = await learn(repo.dir, seen, ["--max-cost-usd", "0.1"]);
    expect(seen).toHaveLength(1);
    expect(result.err).toContain("left by the spend limit");
  });

  it("with --propose, opens a pull request with the learnings and writes nothing here", async () => {
    const repo = repoWithFix();
    const github = fakeGitHub();
    const env = { GITHUB_TOKEN: "ghs_test", GITHUB_REPOSITORY: "o/r" };
    const result = await learn(repo.dir, [], ["--propose"], { env, fetch: github.fetch });
    expect(result.code).toBe(0);
    expect(result.out).toBe("https://github.com/o/r/pull/9\n");
    expect(result.err).toContain("it merges once its checks pass");
    const tree = github.body("POST", "/git/trees") as { tree: { path: string; content: string }[] };
    expect(tree.tree.map((f) => f.path)).toEqual([
      ".ocra/learnings/release-pooled-connections-on-every-exit-path.md",
    ]);
    expect(tree.tree[0]?.content).toContain("kind: fix-commit");
    expect(github.calls.some((c) => c.path.endsWith("/graphql"))).toBe(true);
    expect(existsSync(join(repo.dir, ".ocra"))).toBe(false);
    expect(result.out + result.err).not.toContain("ghs_test");
  });

  it("opens no pull request when no learning was kept", async () => {
    const repo = repoWithFix();
    await learn(repo.dir, []);
    const github = fakeGitHub();
    const env = { GITHUB_TOKEN: "ghs_test", GITHUB_REPOSITORY: "o/r" };
    const result = await learn(repo.dir, [], ["--propose"], { env, fetch: github.fetch });
    expect(result.out).toBe("");
    expect(github.calls).toEqual([]);
  });

  it("leaves the pull request to a person under learnings.requireReview", async () => {
    const repo = repoWithFix();
    repo.commit("chore: config", {
      ".ocra/config.json": JSON.stringify({ learnings: { requireReview: true } }),
    });
    const github = fakeGitHub();
    const env = { GITHUB_TOKEN: "ghs_test", GITHUB_REPOSITORY: "o/r" };
    const result = await learn(repo.dir, [], ["--propose"], { env, fetch: github.fetch });
    expect(result.err).toContain("opened for review (learnings.requireReview)");
    expect(github.calls.some((c) => c.path.endsWith("/graphql"))).toBe(false);
  });

  it("refuses an unknown subcommand with the usage", async () => {
    const result = await learn(repos.create().dir, [], ["--max", "0"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--max must be a positive whole number");
    expect(result.err).toContain("Usage: ocra learn mine");
  });
});

function fakeGitHub() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const answers: Record<string, unknown> = {
    "GET ": { default_branch: "main", allow_auto_merge: true },
    "GET /git/ref/heads/main": { object: { sha: "a".repeat(40) } },
    [`GET /git/commits/${"a".repeat(40)}`]: { tree: { sha: "t1" } },
    "POST /git/trees": { sha: "t2" },
    "POST /git/commits": { sha: "c".repeat(40) },
    "POST /git/refs": {},
    "POST /pulls": { number: 9, node_id: "PR_9", html_url: "https://github.com/o/r/pull/9" },
    "POST /graphql": { data: {} },
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = url
      .replace("https://api.github.com/repos/o/r", "")
      .replace("https://api.github.com", "");
    const call = {
      method: init?.method ?? "GET",
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const answer = answers[`${call.method} ${path}`];
    return new Response(JSON.stringify(answer ?? { message: "Not Found" }), {
      status: answer ? 200 : 404,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    fetch: fetchImpl,
    body: (method: string, path: string) =>
      calls.find((c) => c.method === method && c.path === path)?.body,
  };
}
