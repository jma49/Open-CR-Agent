import { errorMessage } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { GitLabApi, GitLabApiError } from "./client.js";

function api(responses: (Response | Error)[], project: string | number = "group/sub/project") {
  const urls: string[] = [];
  const methods: string[] = [];
  const waits: number[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    methods.push(init?.method ?? "GET");
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  const client = new GitLabApi(project, {
    token: "glpat-secret",
    baseUrl: "https://gitlab.example.com/api/v4/",
    fetch: fetchImpl,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { client, urls, methods, waits };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers });
const note = (id: number) => ({
  id,
  body: "b",
  author: { id: 1, username: "u" },
  system: false,
  type: null,
});

describe("GitLabApi", () => {
  it("addresses a project by its encoded path and reads every page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => note(i + 1));
    const { client, urls } = api([json(full), json([note(101)])]);
    expect(await client.listNotes(7)).toHaveLength(101);
    expect(urls).toEqual([
      "https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproject/merge_requests/7/notes?sort=asc&order_by=created_at&per_page=100&page=1",
      "https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproject/merge_requests/7/notes?sort=asc&order_by=created_at&per_page=100&page=2",
    ]);
  });

  it("refuses commit ids that git could read as an option", async () => {
    const mr = (head: string) =>
      json({
        iid: 7,
        title: "t",
        description: null,
        author: null,
        web_url: "u",
        source_project_id: 1,
        target_project_id: 1,
        diff_refs: { base_sha: "b".repeat(40), start_sha: "b".repeat(40), head_sha: head },
      });
    await expect(api([mr("--upload-pack=touch /tmp/x")]).client.getMergeRequest(7)).rejects.toThrow(
      "not a commit id",
    );
    await expect(api([mr("c".repeat(40))]).client.getMergeRequest(7)).resolves.toMatchObject({
      iid: 7,
    });
  });

  it("reads who last edited each note from GraphQL, next to the REST API", async () => {
    const editors = json({
      data: {
        project: {
          mergeRequest: {
            notes: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { id: "gid://gitlab/Note/5", lastEditedBy: { username: "m" } },
                { id: "gid://gitlab/DiffNote/6", lastEditedBy: null },
              ],
            },
          },
        },
      },
    });
    const { client, urls } = api([json({ path_with_namespace: "group/sub/project" }), editors]);
    expect([...(await client.noteEditors(7))]).toEqual([
      [5, "m"],
      [6, undefined],
    ]);
    expect(urls[1]).toBe("https://gitlab.example.com/api/graphql");
  });

  it("reads a non-member's role as none", async () => {
    const { client } = api([json({ message: "404 Not found" }, 404)]);
    expect(await client.accessLevel(3)).toBe(0);
  });

  it("waits out a rate limit, and never repeats a POST GitLab may have acted on", async () => {
    const limited = api([json({}, 429, { "retry-after": "3" }), json({ id: 1, username: "bot" })]);
    expect(await limited.client.currentUser()).toEqual({ id: 1, username: "bot" });
    expect(limited.waits).toEqual([3_000]);

    const outage = api([json({}, 502), json({})]);
    await expect(outage.client.createNote(7, "hi")).rejects.toBeInstanceOf(GitLabApiError);
    expect(outage.methods).toEqual(["POST"]);

    const read = api([json({}, 503), new TypeError("fetch failed"), json([])]);
    expect(await read.client.listDiscussions(7)).toEqual([]);
    expect(read.methods).toEqual(["GET", "GET", "GET"]);
  });

  it("names the request that failed, without the token", async () => {
    const { client } = api([json({ message: "403 Forbidden" }, 403)]);
    const error = await client.createNote(7, "hi").catch((e: Error) => e);
    expect(error).toBeInstanceOf(GitLabApiError);
    expect(errorMessage(error)).toBe(
      'GitLab POST /merge_requests/7/notes failed with 403: {"message":"403 Forbidden"}',
    );
    expect(errorMessage(error)).not.toContain("glpat-secret");
  });
});
