import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTaskSpec, OcraPlugin } from "@open-cr-agent/core";

// A pull request that moves between reviews, shared by the incremental
// re-review tests and the report golden test.

const dirs: string[] = [];
// Call from afterEach: removes the repositories made since the last call.
export function removePullRequests(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

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
export function movingPullRequest() {
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
    // The summary comment ocra last wrote.
    summary: () => summary,
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
export function reviewer(options: { fail?: boolean; silent?: boolean } = {}) {
  const reviewed: string[][] = [];
  const script = async function* (spec: AgentTaskSpec): AsyncIterable<AgentEvent> {
    const files = ["a.ts", "b.ts"].filter((f) =>
      spec.userPrompt.includes(`<ocra_file path="${f}"`),
    );
    reviewed.push(files);
    if (options.fail) {
      yield { type: "error", taskId: spec.taskId, error: "model unavailable", retryable: false };
      return;
    }
    for (const file of options.silent ? [] : files) {
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
