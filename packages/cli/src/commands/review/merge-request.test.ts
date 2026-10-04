import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../run.js";
import { BUILTIN_PLUGINS } from "../review.js";
import {
  capture,
  changeRequestFixture,
  fakeGitLab,
  removeFixtures,
  warningRuntime,
} from "./change-request.fakes.js";
import type { ReviewDeps } from "./deps.js";
import { BUILTIN_RUNTIMES } from "./runtimes.js";

afterEach(removeFixtures);

function deps(cwd: string, fetchImpl: typeof fetch, env: Record<string, string>): ReviewDeps {
  return {
    cwd,
    env,
    builtinPlugins: BUILTIN_PLUGINS,
    runtimes: { opencode: async () => warningRuntime },
    writeFile: async () => {},
    now: Date.now,
    heartbeatMs: 60_000,
    fetch: fetchImpl,
  };
}

describe("ocra review --mr", () => {
  it("reviews the merge request with trusted inputs from its base and publishes", async () => {
    const { clone, base, head, marker } = changeRequestFixture();
    const gitlab = fakeGitLab(base, head);
    const err = capture();
    const code = await run(
      ["review", "--mr", "7", "--project", "o/r", "--publish"],
      capture(),
      err,
      deps(clone, gitlab.fetchImpl, { GITLAB_TOKEN: "glpat-t" }),
    );
    expect(err.text()).toContain("Published the review to the merge request");
    expect(code).toBe(0);
    // The head's plugin never ran.
    expect(existsSync(marker)).toBe(false);

    const thread = gitlab.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/projects/o%2Fr/merge_requests/7/discussions"),
    );
    expect(thread?.body).toMatchObject({
      position: {
        position_type: "text",
        base_sha: base,
        start_sha: base,
        head_sha: head,
        new_path: "app.ts",
        new_line: 2,
      },
    });
    // A quick action in model text never starts a line.
    expect((thread?.body as { body?: string } | undefined)?.body).not.toMatch(/^[ \t]*\//m);
    const summary = gitlab.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/merge_requests/7/notes"),
    );
    expect((summary?.body as { body?: string } | undefined)?.body).toContain(
      "<!-- ocra:review -->",
    );
    // Every request carried the token, and only to the API.
    expect(gitlab.calls.every((c) => c.url.startsWith("https://gitlab.com/api/"))).toBe(true);
  });

  it("names the merge request when Ctrl-C comes during publishing", async () => {
    const { clone, base, head } = changeRequestFixture();
    const gitlab = fakeGitLab(base, head);
    const handlers: (() => void)[] = [];
    const err = capture();
    await run(["review", "--mr", "7", "--project", "o/r", "--publish"], capture(), err, {
      ...deps(clone, gitlab.fetchImpl, { GITLAB_TOKEN: "glpat-t" }),
      onInterrupt: (handler) => {
        handlers.push(handler);
        return () => {};
      },
    });
    // The last handler is the one held while publishing.
    handlers.at(-1)?.();
    expect(err.text()).toContain("may leave the merge request half updated");
  });

  it("takes the project and the API from GitLab CI's variables", async () => {
    const { clone, base, head } = changeRequestFixture();
    const api = "https://gitlab.example.com/api/v4";
    const gitlab = fakeGitLab(base, head, api);
    const code = await run(
      ["review", "--mr", "7", "--plan"],
      capture(),
      capture(),
      deps(clone, gitlab.fetchImpl, {
        GITLAB_TOKEN: "glpat-t",
        CI_PROJECT_ID: "42",
        CI_API_V4_URL: api,
      }),
    );
    expect(code).toBe(0);
    expect(gitlab.calls[0]?.url).toBe(`${api}/projects/42/merge_requests/7`);
  });

  it("sends the token to gitlab.com only when origin is there, unless told where", async () => {
    const { clone, base, head } = changeRequestFixture();
    const origin = (url: string) =>
      execFileSync("git", ["-C", clone, "remote", "set-url", "origin", url]);
    const gitlab = fakeGitLab(base, head);
    const review = (err = capture()) =>
      run(
        ["review", "--mr", "7", "--plan"],
        capture(),
        err,
        deps(clone, gitlab.fetchImpl, { GITLAB_TOKEN: "glpat-t" }),
      );

    origin("git@gitlab.example.com:o/r.git");
    const err = capture();
    expect(await review(err)).toBe(2);
    expect(err.text()).toContain(
      "origin is on gitlab.example.com, not gitlab.com: set CI_API_V4_URL to its API, such as https://gitlab.example.com/api/v4",
    );
    // The token went nowhere.
    expect(gitlab.calls).toEqual([]);

    // GitLab.com's SSH host is still GitLab.com.
    origin("ssh://git@altssh.gitlab.com:443/o/r.git");
    expect(await review()).toBe(0);
    expect(gitlab.calls[0]?.url).toBe("https://gitlab.com/api/v4/projects/o%2Fr/merge_requests/7");
  });

  it("warns when the API is on another host than origin", async () => {
    const { clone, base, head } = changeRequestFixture();
    execFileSync("git", [
      "-C",
      clone,
      "remote",
      "set-url",
      "origin",
      "https://gitlab.example.com/o/r.git",
    ]);
    const api = "https://gitlab.other.example/api/v4";
    const gitlab = fakeGitLab(base, head, api);
    const err = capture();
    const code = await run(
      ["review", "--mr", "7", "--plan"],
      capture(),
      err,
      deps(clone, gitlab.fetchImpl, { GITLAB_TOKEN: "glpat-t", CI_API_V4_URL: api }),
    );
    expect(code).toBe(0);
    expect(err.text()).toContain(
      "CI_API_V4_URL is on gitlab.other.example but origin is on gitlab.example.com; GITLAB_TOKEN goes to gitlab.other.example",
    );
  });

  it("explains what is missing", async () => {
    const { clone } = changeRequestFixture();
    const err = capture();
    const code = await run(["review", "--mr", "7"], capture(), err, {
      cwd: clone,
      env: {},
      builtinPlugins: BUILTIN_PLUGINS,
      runtimes: BUILTIN_RUNTIMES,
      writeFile: async () => {},
      now: Date.now,
      heartbeatMs: 60_000,
    });
    expect(code).toBe(2);
    expect(err.text()).toContain("--mr needs a GitLab token in GITLAB_TOKEN");
    const usage = capture();
    await run(["review", "--pr", "7", "--mr", "7"], capture(), usage, {
      cwd: clone,
      env: {},
      builtinPlugins: BUILTIN_PLUGINS,
      runtimes: BUILTIN_RUNTIMES,
      writeFile: async () => {},
      now: Date.now,
      heartbeatMs: 60_000,
    });
    expect(usage.text()).toContain("--pr cannot be combined with --mr");
  });
});
