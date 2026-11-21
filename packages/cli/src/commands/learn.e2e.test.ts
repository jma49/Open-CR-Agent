import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompletionRequest, OcraPlugin } from "@open-cr-agent/core";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { capture, deps } from "../run.fakes.js";
import { run } from "../run.js";
import {
  changeRequestFixture,
  fakeGitHub as fakeGitHub7,
  removeFixtures,
} from "./review/change-request.fakes.js";
import type { ReviewDeps } from "./review/deps.js";

const repos = scratchRepos("ocra-learn-");
afterEach(() => {
  repos.removeAll();
  removeFixtures();
});

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

// An origin whose ocra/learnings-* branch, from the repository's main,
// adds one learning.
function withProposal(
  repo: ReturnType<typeof repoWithFix>,
  id: string,
  learning: { title: string; paths: string; ref: string },
) {
  const origin = repos.create();
  origin.git("fetch", "-q", repo.dir, "main");
  origin.git("checkout", "-q", "-b", "ocra/learnings-20261120000000", "FETCH_HEAD");
  origin.commit("chore(ocra): add 1 learning(s) from fix commits", {
    [`.ocra/learnings/${id}.md`]: [
      "---",
      `title: ${learning.title}`,
      "paths:",
      `  - ${learning.paths}`,
      "source:",
      "  kind: fix-commit",
      `  ref: ${learning.ref}`,
      "created: 2026-11-20",
      "---",
      "",
      "Body.",
      "",
    ].join("\n"),
  });
  repo.git("remote", "add", "origin", origin.dir);
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
  command = "mine",
) {
  const out = capture();
  const err = capture();
  const code = await run(["learn", command, ...args], out, err, withDrafts(cwd, seen, extra));
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

  it("skips a fix a proposal waiting on origin already records", async () => {
    const repo = repoWithFix();
    withProposal(repo, "release-pooled-connections", {
      title: "Release pooled connections",
      paths: "src/db/**",
      ref: repo.git("rev-parse", "HEAD~1"),
    });
    const seen: CompletionRequest[] = [];
    const result = await learn(repo.dir, seen);
    expect(seen).toEqual([]);
    expect(result.out).toBe("");
    expect(result.err).toContain("1 already proposed");
    expect(repo.git("branch", "--all", "--list", "*learnings*")).toBe("");
  });

  it("with --propose, names a learning apart from the files proposals on origin hold", async () => {
    const repo = repoWithFix();
    withProposal(repo, "release-pooled-connections-on-every-exit-path", {
      title: "Close report cursors",
      paths: "src/reports/**",
      ref: "0123abc",
    });
    const github = fakeGitHub();
    const env = { GITHUB_TOKEN: "ghs_test", GITHUB_REPOSITORY: "o/r" };
    await learn(repo.dir, [], ["--propose"], { env, fetch: github.fetch });
    const tree = github.body("POST", "/git/trees") as { tree: { path: string }[] };
    expect(tree.tree.map((f) => f.path)).toEqual([
      ".ocra/learnings/release-pooled-connections-on-every-exit-path-2.md",
    ]);
  });

  it("drafts as before, with a warning, when origin cannot be read", async () => {
    const repo = repoWithFix();
    repo.git("remote", "add", "origin", join(repo.dir, "no-such-remote"));
    const seen: CompletionRequest[] = [];
    const result = await learn(repo.dir, seen);
    expect(seen).toHaveLength(1);
    expect(result.err).toContain("a lesson waiting in one may be drafted again");
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
    expect(result.err).toContain("opened for a person to review and merge");
    expect(github.calls.some((c) => c.path.endsWith("/graphql"))).toBe(false);
  });

  it("leaves the pull request to a person with --require-review, and only with --propose", async () => {
    const repo = repoWithFix();
    const github = fakeGitHub();
    const env = { GITHUB_TOKEN: "ghs_test", GITHUB_REPOSITORY: "o/r" };
    const result = await learn(repo.dir, [], ["--propose", "--require-review"], {
      env,
      fetch: github.fetch,
    });
    expect(result.err).toContain("opened for a person to review and merge");
    expect(github.calls.some((c) => c.path.endsWith("/graphql"))).toBe(false);
    expect((await learn(repo.dir, [], ["--require-review"])).err).toContain(
      "--require-review goes with --propose",
    );
  });

  it("with --propose --project, opens a GitLab merge request instead", async () => {
    const repo = repoWithFix();
    const gitlab = fakeGitLab();
    const env = { GITLAB_TOKEN: "glpat-test", CI_API_V4_URL: "https://gitlab.example.com/api/v4" };
    const result = await learn(repo.dir, [], ["--propose", "--project", "g/p"], {
      env,
      fetch: gitlab.fetch,
    });
    expect(result.code).toBe(0);
    expect(result.out).toBe("https://gitlab.example.com/g/p/-/merge_requests/4\n");
    expect(result.err).toContain("Merge request opened; it merges once its checks pass");
    const commit = gitlab.body("POST", "/repository/commits") as {
      actions: { action: string; file_path: string }[];
    };
    expect(commit.actions).toMatchObject([
      {
        action: "create",
        file_path: ".ocra/learnings/release-pooled-connections-on-every-exit-path.md",
      },
    ]);
    expect(gitlab.body("PUT", "/merge_requests/4/merge")).toMatchObject({
      merge_when_pipeline_succeeds: true,
    });
    expect(existsSync(join(repo.dir, ".ocra"))).toBe(false);
    expect(result.out + result.err).not.toContain("glpat-test");
  });

  it("asks which platform --propose means when nothing tells", async () => {
    const repo = repoWithFix();
    const env = { GITHUB_TOKEN: "ghs_test", GITLAB_TOKEN: "glpat-test" };
    const result = await learn(repo.dir, [], ["--propose"], { env });
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("pass --repo <owner/name> or --project <id|path>");
    expect((await learn(repo.dir, [], ["--project", "g/p"])).err).toContain(
      "--project with --mr or --propose",
    );
  });

  it("drafts from the findings the team accepted, with their reason", async () => {
    const repo = repos.create();
    const fingerprint = "0123456789abcdef";
    repo.commit("chore: accept a finding", {
      "src/db/query.ts": "export const conn = await pool.acquire();\n",
      ".ocra/memory.json": JSON.stringify({
        accepted: [
          {
            fingerprint,
            file: "src/db/query.ts",
            title: "Connection is never released",
            reason: "The pool reclaims idle connections after 30 seconds.",
          },
        ],
      }),
    });
    const seen: CompletionRequest[] = [];
    const result = await learn(repo.dir, seen, [], {}, "feedback");
    expect(result.code).toBe(0);
    expect(seen[0]?.user).toContain("The pool reclaims idle connections after 30 seconds.");
    const text = readFileSync(join(repo.dir, result.out.trim()), "utf8");
    expect(text).toContain("kind: review-feedback");
    expect(text).toContain(`ref: ${fingerprint}`);
    expect(text).toContain("  - src/db/**");
    const again = await learn(repo.dir, [], [], {}, "feedback");
    expect(again.err).toContain("1 already recorded");
  });

  it("drafts from the sections of a document that name files of the repository", async () => {
    const repo = repoWithFix();
    repo.write(
      "docs/postmortem.md",
      "# Pool outage\n\n## Release connections\n\nsrc/db/query.ts must release every connection it acquires.\n\n## Timeline\n\nIt happened on Friday.\n",
    );
    const seen: CompletionRequest[] = [];
    const result = await learn(repo.dir, seen, ["docs/postmortem.md"], {}, "import");
    expect(result.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.user).toContain("Release connections");
    const text = readFileSync(join(repo.dir, result.out.trim()), "utf8");
    expect(text).toContain("ref: docs/postmortem.md#release-connections");
    expect(result.err).toContain("1 held no lesson");
  });

  it("drafts what a maintainer asked a pull request to remember, from its base", async () => {
    const { clone, base, head } = changeRequestFixture();
    const note = {
      id: 4,
      node_id: "IC_4",
      user: { login: "maintainer", type: "User" },
      body: "/ocra remember Retries must never be negative in app.ts.",
    };
    const seen: CompletionRequest[] = [];
    const result = await learn(
      clone,
      seen,
      ["--pr", "7", "--repo", "o/r"],
      {
        env: { GITHUB_TOKEN: "t" },
        fetch: fakeGitHub7(base, head, [note]).fetchImpl,
      },
      "remember",
    );
    expect(result.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.user).toContain("Retries must never be negative in app.ts.");
    expect(seen[0]?.user).toContain("export const retries = -1;");
    const text = readFileSync(join(clone, result.out.trim()), "utf8");
    expect(text).toContain("kind: remember");
    expect(text).toContain("ref: o/r#7/4");
  });

  it("refuses remember without a pull or merge request, and --pr elsewhere", async () => {
    const dir = repos.create().dir;
    expect((await learn(dir, [], [], {}, "remember")).err).toContain("needs --pr or --mr");
    expect((await learn(dir, [], ["--pr", "7"])).err).toContain("go with ocra learn remember");
  });

  it("refuses an unknown subcommand with the usage", async () => {
    const result = await learn(repos.create().dir, [], ["--max", "0"]);
    expect(result.code).toBe(2);
    expect((await learn(repos.create().dir, [], [], {}, "everything")).err).toContain(
      "Unknown learn command: everything",
    );
    expect(result.err).toContain("--max must be a positive whole number");
    expect(result.err).toContain("Usage: ocra learn <mine|feedback|import");
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

function fakeGitLab() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const mr = { iid: 4, web_url: "https://gitlab.example.com/g/p/-/merge_requests/4" };
  const answers: Record<string, unknown> = {
    "GET ": { default_branch: "main" },
    "POST /repository/commits": { id: "c" },
    "POST /merge_requests": mr,
    "GET /merge_requests/4": { ...mr, merge_status: "can_be_merged", head_pipeline: { id: 1 } },
    "PUT /merge_requests/4/merge": { ...mr, state: "opened", merge_when_pipeline_succeeds: true },
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://gitlab.example.com/api/v4/projects/g%2Fp", "");
    const call = {
      method: init?.method ?? "GET",
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const answer = answers[`${call.method} ${path}`];
    return new Response(JSON.stringify(answer ?? { message: "404 Not Found" }), {
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
