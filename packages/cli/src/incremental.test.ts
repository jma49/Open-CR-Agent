import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTaskSpec, OcraPlugin, ReviewReport } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_PLUGINS, type ReviewDeps } from "./review/command.js";
import { run } from "./run.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "ocra-incr-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  return { dir, git };
}

function commit(r: ReturnType<typeof repo>, files: Record<string, string>, message: string) {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(r.dir, path), content);
  r.git("add", "-A");
  r.git("commit", "-q", "-m", message);
  return r.git("rev-parse", "HEAD");
}

// A pull request whose head moves between runs, and a GitHub that keeps
// ocra's summary comment from one run to the next.
function fixture() {
  const upstream = repo();
  const base = commit(
    upstream,
    { "a.ts": "export const a = 0;\n", "b.ts": "export const b = 0;\n" },
    "base",
  );
  upstream.git("switch", "-q", "-c", "feature");
  let head = commit(
    upstream,
    { "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" },
    "one",
  );
  const clone = repo();
  clone.git("remote", "add", "origin", upstream.dir);
  clone.git("fetch", "-q", "origin", "main");
  clone.git("checkout", "-q", "FETCH_HEAD");

  let summary: string | undefined;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.github.com/repos/o/r", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/graphql")) {
      if ((body.query as string).includes("node(id: $id)"))
        return json({ data: { node: { editor: null } } });
      return json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        },
      });
    }
    if (path === "/pulls/7") {
      return json({
        number: 7,
        title: "Change a and b",
        body: "",
        html_url: "https://github.com/o/r/pull/7",
        user: { login: "contributor" },
        base: { sha: base, ref: "main" },
        head: { sha: head, ref: "feature" },
      });
    }
    if (path.startsWith("/issues/7/comments") && method === "GET") {
      const user = { login: "github-actions[bot]", type: "Bot" };
      return json(summary ? [{ id: 1, node_id: "IC_1", body: summary, user }] : []);
    }
    if (path === "/issues/7/comments" || path === "/issues/comments/1") summary = body.body;
    return json({});
  }) as typeof fetch;

  return {
    upstream,
    clone: clone.dir,
    fetchImpl,
    push(files: Record<string, string>) {
      head = commit(upstream, files, "more");
    },
    forcePush(files: Record<string, string>) {
      upstream.git("reset", "-q", "--hard", base);
      head = commit(upstream, files, "rewritten");
    },
  };
}

// Reports a finding on every file the task was given; fails when told to.
function reviewer(options: { fail?: boolean } = {}) {
  const reviewed: string[][] = [];
  const script = async function* (spec: AgentTaskSpec): AsyncIterable<AgentEvent> {
    const files = ["a.ts", "b.ts"].filter((f) => spec.userPrompt.includes(`<file path="${f}"`));
    reviewed.push(files);
    if (options.fail) {
      yield { type: "error", taskId: spec.taskId, error: "model unavailable", retryable: false };
      return;
    }
    for (const file of files) {
      const letter = file[0];
      yield {
        type: "finding",
        taskId: spec.taskId,
        finding: {
          category: "correctness",
          severity: "warning",
          file,
          existingCode: `export const ${letter} = 1;`,
          title: `Check ${letter}`,
          body: "b",
          evidence: [],
        },
      };
    }
    yield { type: "done", taskId: spec.taskId };
  };
  const plugin: OcraPlugin = {
    name: "runtime-opencode",
    configure(ctx) {
      ctx.registerRuntime("opencode", () => ({ name: "fake", runTask: (spec) => script(spec) }));
    },
  };
  return { plugin, reviewed };
}

async function review(
  f: ReturnType<typeof fixture>,
  runtime: ReturnType<typeof reviewer>,
  extra: string[] = [],
): Promise<ReviewReport> {
  const out = { text: "", write: (c: string) => (out.text += c) };
  const deps: ReviewDeps = {
    cwd: f.clone,
    env: { GITHUB_TOKEN: "t" },
    builtinPlugins: BUILTIN_PLUGINS.map((p) =>
      p.name === runtime.plugin.name ? runtime.plugin : p,
    ),
    writeFile: async () => {},
    now: Date.now,
    heartbeatMs: 60_000,
    fetch: f.fetchImpl,
  };
  const err = { write: () => {} };
  await run(
    ["review", "--pr", "7", "--repo", "o/r", "--publish", "--format", "json", ...extra],
    out,
    err,
    deps,
  );
  return JSON.parse(out.text) as ReviewReport;
}

const statuses = (r: ReviewReport) => Object.fromEntries(r.coverage.map((c) => [c.path, c.status]));

describe("incremental re-review of a pull request", () => {
  it("reviews only the files changed by new commits and carries the rest", async () => {
    const f = fixture();
    const first = await review(f, reviewer());
    expect(first.scope).toBeUndefined();
    expect(first.findings.map((x) => x.file).sort()).toEqual(["a.ts", "b.ts"]);

    f.push({ "b.ts": "export const b = 1;\nexport const c = 2;\n" });
    const runtime = reviewer();
    const second = await review(f, runtime);
    expect(runtime.reviewed).toEqual([["b.ts"]]);
    expect(second.scope).toMatchObject({ mode: "incremental" });
    expect(statuses(second)).toEqual({ "a.ts": "unchanged", "b.ts": "reviewed" });
    expect(second.findings.map((x) => [x.file, x.status])).toEqual([["b.ts", "unfixed"]]);
    expect(second.rereview?.unchanged.map((x) => x.file)).toEqual(["a.ts"]);
    expect(second.rereview?.fixed).toEqual([]);
    expect(second.verdict).toBe("approved_with_comments");

    const full = reviewer();
    const forced = await review(f, full, ["--full"]);
    expect(full.reviewed).toEqual([["a.ts", "b.ts"]]);
    expect(forced.scope).toEqual({ mode: "full", reason: "a full review was requested" });
  });

  it("reviews everything again after a force-push and says why", async () => {
    const f = fixture();
    await review(f, reviewer());
    f.forcePush({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" });
    const runtime = reviewer();
    const report = await review(f, runtime);
    expect(runtime.reviewed).toEqual([["a.ts", "b.ts"]]);
    expect(report.scope?.mode).toBe("full");
    expect(report.scope).toMatchObject({
      reason: expect.stringContaining("is not an ancestor of the new head (force-push or rebase)"),
    });
  });

  it("reviews files the previous run did not finish, even if unchanged", async () => {
    const f = fixture();
    const failed = await review(f, reviewer({ fail: true }));
    expect(statuses(failed)).toEqual({ "a.ts": "failed", "b.ts": "failed" });

    f.push({ "b.ts": "export const b = 1;\nexport const c = 2;\n" });
    const runtime = reviewer();
    const report = await review(f, runtime);
    expect(runtime.reviewed).toEqual([["a.ts", "b.ts"]]);
    expect(report.scope).toMatchObject({ mode: "incremental" });
    expect(statuses(report)).toEqual({ "a.ts": "reviewed", "b.ts": "reviewed" });
  });
});
