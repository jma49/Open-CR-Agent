import type { FileDiff } from "@open-cr-agent/core";
import type { CodeSource } from "@open-cr-agent/vcs-platform";
import {
  AUTHOR,
  BASE,
  HEAD,
  MAINTAINER,
  OCRA,
  OUTSIDER,
  type Scenario,
} from "../../vcs-platform/src/conformance.fakes.js";
import { GitLabAdapter } from "./adapter.js";
import { GitLabApi } from "./client.js";

// A fake GitLab REST and GraphQL API over a conformance scenario, recording
// what the adapter sends. Shared by the GitLab tests.

// The bot user of a project access token.
const BOT = "project_42_bot_7f3a";
export const START = "d".repeat(40);
const API = "https://gitlab.example.com/api/v4";

const USER_IDS: Record<string, number> = { [AUTHOR]: 1, [MAINTAINER]: 2, [OUTSIDER]: 3, [BOT]: 99 };
// Developer and Maintainer; the outsider is not a member (404).
const ACCESS: Record<number, number> = { 1: 30, 2: 40, 99: 30 };

export interface Call {
  method: string;
  path: string;
  body?: unknown;
}

export interface FakeGitLabOptions {
  // Status for creating a thread: 201, or 400 for a position GitLab rejects.
  discussionStatus?: (call: Call) => number;
  // Leave these notes out of the GraphQL editors answer.
  unknownEditors?: number[];
  graphqlFails?: boolean;
  diffRefs?: null;
  // The project's "resolve outdated threads on push" setting; null leaves it
  // out of GitLab's answer.
  resolvesOutdatedOnPush?: boolean | null;
  // Notes someone edits right after the first GraphQL read of editors.
  editedAfterFirstRead?: Record<number, string>;
}

// src/login.ts, where line 2 was added and lines 1 and 3 are context.
export const diff: FileDiff = {
  oldPath: "src/login.ts",
  newPath: "src/login.ts",
  kind: "modified",
  isBinary: false,
  additions: 1,
  deletions: 0,
  patch: "@@ -1,2 +1,3 @@\n a\n+b\n c\n",
  hunks: [
    {
      header: "@@ -1,2 +1,3 @@",
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 3,
      lines: [
        { kind: "context", content: "a", oldLine: 1, newLine: 1 },
        { kind: "add", content: "b", newLine: 2 },
        { kind: "context", content: "c", oldLine: 2, newLine: 3 },
      ],
    },
  ],
};

const code: CodeSource = {
  getDiff: async () => [diff],
  readFile: async () => undefined,
  searchCode: async () => [],
};

const user = (login: string) => ({ id: USER_IDS[login] ?? 77, username: login });

export function fakeGitLab(scenario: Scenario, options: FakeGitLabOptions = {}) {
  const spell = (login: string) => (login === OCRA ? BOT : login);
  const calls: Call[] = [];
  const edited = new Map<number, string>();
  const notes = (scenario.comments ?? []).map((c, i) => {
    if (c.editedBy) edited.set(i + 1, spell(c.editedBy));
    return {
      id: i + 1,
      body: c.body,
      author: user(spell(c.author)),
      system: false,
      type: null,
    };
  });
  const discussions = (scenario.threads ?? []).map((t, i) => ({
    id: `d${i}`,
    individual_note: false,
    notes: t.comments.map((c, j) => {
      const id = 100 * (i + 1) + j;
      if (c.editedBy) edited.set(id, spell(c.editedBy));
      return {
        id,
        body: c.body,
        author: user(spell(c.author)),
        system: false,
        type: "DiffNote",
        resolvable: true,
        resolved: j === 0 && t.resolvedBy !== undefined,
        resolved_by: j === 0 && t.resolvedBy ? user(t.resolvedBy) : null,
      };
    }),
  }));
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace(API, "").replace("https://gitlab.example.com/api", "");
    const call: Call = { method, path };
    if (init?.body) call.body = JSON.parse(init.body as string);
    calls.push(call);
    if (path === "/graphql") {
      if (options.graphqlFails) return json({ message: "Bad gateway" }, 502);
      const ids = [
        ...notes.map((n) => n.id),
        ...discussions.flatMap((d) => d.notes.map((n) => n.id)),
      ];
      const nodes = ids
        .filter((id) => !options.unknownEditors?.includes(id))
        .map((id) => ({
          id: `gid://gitlab/Note/${id}`,
          lastEditedBy: edited.has(id) ? { username: edited.get(id) } : null,
        }));
      for (const [id, by] of Object.entries(options.editedAfterFirstRead ?? {})) {
        edited.set(Number(id), spell(by));
      }
      return json({
        data: {
          project: {
            mergeRequest: {
              notes: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
            },
          },
        },
      });
    }
    if (path === "/user") return json(user(BOT));
    if (path.startsWith("/users?")) {
      const name = new URL(url).searchParams.get("username") ?? "";
      return json(USER_IDS[name] ? [user(name)] : []);
    }
    const project = "/projects/group%2Fproject";
    if (path === project) {
      const setting =
        options.resolvesOutdatedOnPush === undefined ? false : options.resolvesOutdatedOnPush;
      return json({
        id: 42,
        path_with_namespace: "group/project",
        ...(setting === null ? {} : { resolve_outdated_diff_discussions: setting }),
      });
    }
    const rest = path.startsWith(project) ? path.slice(project.length) : path;
    if (rest === "/merge_requests/7") {
      return json({
        iid: 7,
        title: "Add login",
        description: null,
        author: user(AUTHOR),
        web_url: "https://gitlab.example.com/group/project/-/merge_requests/7",
        source_project_id: 42,
        target_project_id: 42,
        diff_refs:
          options.diffRefs === null ? null : { base_sha: BASE, start_sha: START, head_sha: HEAD },
      });
    }
    if (rest.startsWith("/merge_requests/7/notes?")) return json(notes);
    if (rest.startsWith("/merge_requests/7/discussions?")) return json(discussions);
    const member = /^\/members\/all\/(\d+)$/.exec(rest);
    if (member) {
      const level = ACCESS[Number(member[1])];
      return level ? json({ access_level: level }) : json({ message: "404 Not found" }, 404);
    }
    if (rest === "/merge_requests/7/discussions" && method === "POST") {
      return json({}, options.discussionStatus?.(call) ?? 201);
    }
    if (rest === "/merge_requests/7/notes" && method === "POST") return json({}, 201);
    if (rest.startsWith("/merge_requests/7/notes/") && method === "PUT") return json({});
    if (rest.startsWith("/merge_requests/7/discussions/") && method === "PUT") return json({});
    return json({ message: `unexpected ${method} ${path}` }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

export function adapter(fetchImpl: typeof fetch) {
  return new GitLabAdapter({
    iid: 7,
    api: new GitLabApi("group/project", {
      token: "glpat-secret",
      baseUrl: API,
      fetch: fetchImpl,
      sleep: async () => {},
    }),
    code,
  });
}

export const bodies = (calls: Call[], method: string, pathEnd: string) =>
  calls
    .filter((c) => c.method === method && c.path.split("?")[0]?.endsWith(pathEnd))
    .map((c) => (c.body as { body: string }).body);
