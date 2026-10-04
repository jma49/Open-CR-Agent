import { describe, expect, it } from "vitest";
import { resolveGitLabTarget } from "./target.js";

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);

function gitlab(diffRefs: unknown = { base_sha: BASE, start_sha: BASE, head_sha: HEAD }) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return new Response(
      JSON.stringify({
        iid: 7,
        title: "t",
        description: null,
        author: { id: 5, username: "contributor" },
        source_project_id: 1,
        target_project_id: 1,
        web_url: "https://gitlab.example.com/g/p/-/merge_requests/7",
        diff_refs: diffRefs,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { urls, fetchImpl };
}

function options(env: Record<string, string>, origin: string | undefined, api = gitlab()) {
  const warnings: string[] = [];
  return {
    api,
    warnings,
    options: {
      ref: { number: 7 },
      env,
      origin: async () => origin,
      warn: (message: string) => warnings.push(message),
      fetch: api.fetchImpl,
    },
  };
}

describe("resolveGitLabTarget", () => {
  it("needs a token", async () => {
    const { options: o } = options({}, undefined);
    await expect(resolveGitLabTarget(o)).rejects.toMatchObject({
      code: "CONFIG_CREDENTIALS_MISSING",
    });
  });

  it("finds the project from origin and the API from CI_API_V4_URL", async () => {
    const { options: o, api } = options(
      { GITLAB_TOKEN: "t", CI_API_V4_URL: "https://gitlab.example.com/api/v4" },
      "git@gitlab.example.com:g/p.git",
    );
    const target = await resolveGitLabTarget(o);
    expect(api.urls).toEqual(["https://gitlab.example.com/api/v4/projects/g%2Fp/merge_requests/7"]);
    expect(target).toMatchObject({
      platform: "gitlab",
      baseSha: BASE,
      headSha: HEAD,
      headRefs: ["refs/merge-requests/7/head"],
      webUrl: "https://gitlab.example.com/g/p/-/merge_requests/7",
    });
  });

  it("never sends the token to gitlab.com for a self-managed origin", async () => {
    const { options: o, api } = options({ GITLAB_TOKEN: "t" }, "https://gitlab.example.com/g/p");
    await expect(resolveGitLabTarget(o)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(api.urls).toEqual([]);
  });

  it("warns when the API is on another host than origin", async () => {
    const { options: o, warnings } = options(
      { GITLAB_TOKEN: "t", CI_API_V4_URL: "https://gitlab.example.com/api/v4", CI_PROJECT_ID: "1" },
      "git@gitlab.com:g/p.git",
    );
    await resolveGitLabTarget(o);
    expect(warnings).toEqual([
      "CI_API_V4_URL is on gitlab.example.com but origin is on gitlab.com; GITLAB_TOKEN goes to gitlab.example.com",
    ]);
  });

  it("refuses a merge request without a diff yet", async () => {
    const { options: o } = options({ GITLAB_TOKEN: "t" }, undefined, gitlab(null));
    const target = resolveGitLabTarget({ ...o, ref: { number: 7, repository: "g/p" } });
    await expect(target).rejects.toMatchObject({ code: "VCS_NOT_READY" });
  });
});
