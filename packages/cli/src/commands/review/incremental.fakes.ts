import type { AgentEvent, AgentTaskSpec, OcraPlugin } from "@open-cr-agent/core";
import { scratchRepos } from "@open-cr-agent/test-support";

// A pull request that moves between reviews, shared by the incremental
// re-review tests and the report golden test.

const repos = scratchRepos("ocra-incr-");
// Call from afterEach: removes the repositories made since the last call.
export const removePullRequests = repos.removeAll;

// A pull request whose head moves between runs, and a GitHub that keeps
// ocra's summary comment from one run to the next.
export function movingPullRequest() {
  const upstream = repos.create();
  const base = upstream.commit("base", {
    "a.ts": "export const a = 0;\n",
    "b.ts": "export const b = 0;\n",
  });
  upstream.git("switch", "-q", "-c", "feature");
  let head = upstream.commit("one", {
    "a.ts": "export const a = 1;\n",
    "b.ts": "export const b = 1;\n",
  });
  const clone = repos.create();
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
      head = upstream.commit("more", files);
    },
    forcePush(files: Record<string, string>) {
      upstream.git("reset", "-q", "--hard", base);
      head = upstream.commit("rewritten", files);
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
