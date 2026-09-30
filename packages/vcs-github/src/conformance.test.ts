import {
  AUTHOR,
  BASE,
  conformance,
  HEAD,
  MAINTAINER,
  OCRA,
  type Scenario,
} from "../../vcs-platform/src/conformance.fakes.js";
import { code } from "./adapter.fakes.js";
import { GitHubAdapter } from "./adapter.js";
import { GitHubApi } from "./client.js";

// GitHub spells the Actions bot two ways: REST with "[bot]", GraphQL without.
const REST_BOT = "github-actions[bot]";
const GRAPHQL_BOT = "github-actions";

// The scenario behind GitHub's REST and GraphQL APIs.
function onGitHub(scenario: Scenario) {
  const rest = (login: string) => (login === OCRA ? REST_BOT : login);
  const graphql = (login: string) => (login === OCRA ? GRAPHQL_BOT : login);
  const comments = (scenario.comments ?? []).map((c, i) => ({
    id: i + 1,
    node_id: `IC_${i + 1}`,
    body: c.body,
    user: { login: rest(c.author), type: c.author === OCRA ? "Bot" : "User" },
    editedBy: c.editedBy,
  }));
  const threads = (scenario.threads ?? []).map((t, i) => ({
    id: `T${i}`,
    isResolved: t.resolvedBy !== undefined,
    resolvedBy: t.resolvedBy ? { login: graphql(t.resolvedBy) } : null,
    comments: {
      nodes: t.comments.map((c, j) => ({
        id: `C${i}-${j}`,
        body: c.body,
        authorAssociation: "MEMBER",
        author: { login: graphql(c.author) },
        editor: c.editedBy ? { login: graphql(c.editedBy) } : null,
      })),
    },
  }));
  const inline: string[] = [];
  let summary = "";
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (url.endsWith("/graphql")) {
      const query = body.query as string;
      if (query.includes("node(id: $id)")) {
        const comment = comments.find((c) => c.node_id === body.variables.id);
        const editor = comment?.editedBy ? { login: graphql(comment.editedBy) } : null;
        return json({ data: { node: { editor } } });
      }
      if (query.startsWith("mutation")) return json({ data: { resolveReviewThread: {} } });
      return json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: threads,
              },
            },
          },
        },
      });
    }
    const path = url.replace("https://api.github.com/repos/o/r", "");
    if (path === "/pulls/7") {
      return json({
        number: 7,
        title: "t",
        body: null,
        html_url: "https://github.com/o/r/pull/7",
        user: { login: AUTHOR },
        base: { sha: BASE, ref: "main" },
        head: { sha: HEAD, ref: "feat" },
      });
    }
    if (path.startsWith("/issues/7/comments") && method === "GET") {
      return json(comments.map(({ editedBy: _, ...c }) => c));
    }
    const permission = /^\/collaborators\/([^/]+)\/permission$/.exec(path);
    if (permission) {
      const login = decodeURIComponent(permission[1] ?? "");
      return json({ permission: login === AUTHOR || login === MAINTAINER ? "write" : "read" });
    }
    if (path.startsWith("/pulls/7/files")) return json([{ filename: "src/login.ts", patch: "@@" }]);
    if (path === "/pulls/7/reviews" && method === "POST") {
      inline.push(...body.comments.map((c: { body: string }) => c.body));
      return json({});
    }
    if (path === "/issues/7/comments" || path.startsWith("/issues/comments/")) {
      summary = body.body;
      return json({}, 201);
    }
    return json({ message: `unexpected ${method} ${path}` }, 404);
  }) as typeof fetch;
  const review = new GitHubAdapter({
    pullRequest: { owner: "o", repo: "r", number: 7 },
    api: new GitHubApi(
      { owner: "o", repo: "r" },
      { token: "t", fetch: fetchImpl, sleep: async () => {} },
    ),
    code,
    botLogin: REST_BOT,
  });
  return { review, inline: () => inline, summary: () => summary };
}

conformance("GitHub", { conversation: onGitHub });
