import { describe, expect, it } from "vitest";
import { resolveGitHubTarget } from "./target.js";

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);

function github() {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return new Response(
      JSON.stringify({
        number: 7,
        title: "t",
        body: null,
        html_url: "https://github.com/o/r/pull/7",
        user: null,
        base: { sha: BASE, ref: "main" },
        head: { sha: HEAD, ref: "feature" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { urls, fetchImpl };
}

const options = (env: Record<string, string>, origin?: string) => {
  const api = github();
  let originRead = false;
  return {
    api,
    originRead: () => originRead,
    options: {
      ref: { number: 7 },
      env,
      origin: async () => {
        originRead = true;
        return origin;
      },
      warn: () => {},
      fetch: api.fetchImpl,
    },
  };
};

describe("resolveGitHubTarget", () => {
  it("needs a token", async () => {
    const { options: o } = options({});
    await expect(resolveGitHubTarget(o)).rejects.toMatchObject({
      code: "CONFIG_CREDENTIALS_MISSING",
    });
  });

  it("finds the repository from origin and returns the pull request's commits", async () => {
    const { options: o, api } = options({ GH_TOKEN: "t" }, "git@github.com:o/r.git");
    const target = await resolveGitHubTarget(o);
    expect(api.urls).toEqual(["https://api.github.com/repos/o/r/pulls/7"]);
    expect(target).toMatchObject({
      platform: "github",
      baseSha: BASE,
      headSha: HEAD,
      headRefs: ["pull/7/head"],
      webUrl: "https://github.com/o/r/pull/7",
    });
  });

  it("takes GITHUB_REPOSITORY over origin, which it then does not read", async () => {
    const {
      options: o,
      api,
      originRead,
    } = options({ GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "a/b" });
    await resolveGitHubTarget(o);
    expect(api.urls[0]).toBe("https://api.github.com/repos/a/b/pulls/7");
    expect(originRead()).toBe(false);
  });

  it("refuses an origin that is not on github.com", async () => {
    const { options: o } = options({ GITHUB_TOKEN: "t" }, "https://gitlab.com/o/r.git");
    await expect(resolveGitHubTarget(o)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("gives the adapter the configured settings, and defaults for the rest", async () => {
    const { options: o } = options({ GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" });
    const target = await resolveGitHubTarget(o);
    const created: unknown[] = [];
    const local = {
      code: {
        getDiff: async () => [],
        readFile: async () => undefined,
        searchCode: async () => [],
      },
      history: { filesChangedSince: async () => ({ files: [] }) },
    };
    const registry = {
      createVcs: (name: string, options: unknown) => {
        created.push({ name, options });
        return {} as never;
      },
    };
    target.createVcs(registry, local, { requestChanges: true });
    expect(created).toEqual([
      {
        name: "github",
        options: expect.objectContaining({
          owner: "o",
          repo: "r",
          number: 7,
          botLogin: "github-actions[bot]",
          requestChanges: true,
          code: local.code,
          history: local.history,
          snapshot: { id: "o/r#7", title: "t", description: "", baseSha: BASE, headSha: HEAD },
        }),
      },
    ]);
  });
});
