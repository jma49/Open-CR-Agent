import type { ReviewReport } from "@open-cr-agent/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { capture, critical, deps, removeRepos, repoWithChange } from "../../run.fakes.js";
import { run } from "../../run.js";
import { VERSION } from "../../version.js";
import { BUILTIN_PLUGINS } from "../review.js";
import {
  changeRequestFixture,
  fakeGitHub,
  fakeGitLab,
  removeFixtures,
  warningRuntime,
} from "./change-request.fakes.js";
import type { ReviewDeps } from "./deps.js";
import { movingPullRequest, removePullRequests, reviewer } from "./incremental.fakes.js";

// The JSON report and the pull or merge request summary of the end-to-end
// fixtures, recorded byte for byte, so a refactoring of the orchestration
// (#388) shows any change to what ocra reports. Only what differs between
// runs is replaced: the run id, durations, the version, and the head of the
// change request whose content embeds a path.

const DATE = "2026-01-01T00:00:00Z";
const saved = { author: process.env.GIT_AUTHOR_DATE, committer: process.env.GIT_COMMITTER_DATE };
// Fixed commit dates make the fixtures' commit ids the same on every run.
beforeAll(() => {
  process.env.GIT_AUTHOR_DATE = DATE;
  process.env.GIT_COMMITTER_DATE = DATE;
});
afterAll(() => {
  restore("GIT_AUTHOR_DATE", saved.author);
  restore("GIT_COMMITTER_DATE", saved.committer);
});
afterEach(() => {
  removeRepos();
  removeFixtures();
  removePullRequests();
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const STATE = /<!-- ocra:state v1 ([A-Za-z0-9+/=]+) -->/g;

// Pairs, not an object: an object iterates integer-like keys (a short
// commit id of digits only) first, before the full id they are part of.
type Replacements = readonly (readonly [string, string])[];

function normalize(text: string, values: Replacements): string {
  let result = text.replace(
    STATE,
    (_, encoded: string) =>
      `<!-- ocra:state v1 (decoded) ${Buffer.from(encoded, "base64").toString("utf8")} -->`,
  );
  for (const [value, placeholder] of values) {
    result = result.replaceAll(value, placeholder);
  }
  return result.replace(/"durationMs": \d+/g, '"durationMs": 0');
}

async function record(name: string, json: string, values: Replacements, summary?: string) {
  const { runId } = JSON.parse(json) as ReviewReport;
  const all: Replacements = [
    [runId, "<run-id>"],
    [`"ocraVersion": "${VERSION}"`, '"ocraVersion": "<version>"'],
    ...values,
  ];
  await expect(normalize(json, all)).toMatchFileSnapshot(
    `__snapshots__/report-golden/${name}.json`,
  );
  if (summary !== undefined) {
    await expect(normalize(summary, all)).toMatchFileSnapshot(
      `__snapshots__/report-golden/${name}.summary.md`,
    );
  }
}

async function review(
  argv: string[],
  reviewDeps: ReviewDeps,
): Promise<{ code: number; json: string }> {
  const out = capture();
  const code = await run([...argv, "--format", "json"], out, capture(), reviewDeps);
  return { code, json: out.text() };
}

describe("the reports of the end-to-end fixtures", () => {
  it("a working tree review with Verify and the judge", async () => {
    const { code, json } = await review(["review"], deps(repoWithChange(), critical, {}, true));
    expect(code).toBe(1);
    await record("local-verified", json, []);
  });

  it("a working tree review whose critical finding could not be verified", async () => {
    const { code, json } = await review(["review"], deps(repoWithChange(), critical));
    expect(code).toBe(3);
    await record("local-unverified", json, []);
  });

  it("a working tree review under --ultra", async () => {
    const { code, json } = await review(
      ["review", "--ultra"],
      deps(repoWithChange(), critical, {}, true),
    );
    expect(code).toBe(3);
    await record("local-ultra", json, []);
  });

  it("a published pull request review", async () => {
    const { clone, base, head } = changeRequestFixture();
    const github = fakeGitHub(base, head);
    const { code, json } = await review(["review", "--pr", "7", "--repo", "o/r", "--publish"], {
      ...platformDeps(clone, github.fetchImpl, { GITHUB_TOKEN: "t" }),
    });
    expect(code).toBe(0);
    const summary = github.calls.find(
      (c) => c.method === "POST" && c.path === "/issues/7/comments",
    );
    await record("pull-request", json, heads(head), bodyOf(summary));
  });

  it("a published merge request review", async () => {
    const { clone, base, head } = changeRequestFixture();
    const gitlab = fakeGitLab(base, head);
    const { code, json } = await review(
      ["review", "--mr", "7", "--project", "o/r", "--publish"],
      platformDeps(clone, gitlab.fetchImpl, { GITLAB_TOKEN: "glpat-t" }),
    );
    expect(code).toBe(0);
    const summary = gitlab.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/merge_requests/7/notes"),
    );
    await record("merge-request", json, heads(head), bodyOf(summary));
  });

  it("re-reviews of a pull request: incremental, fixed and unfinished", async () => {
    const f = movingPullRequest();
    const again = async (runtime: ReturnType<typeof reviewer>, name: string, code: number) => {
      const result = await review(["review", "--pr", "7", "--repo", "o/r", "--publish"], {
        ...platformDeps(f.clone, f.fetchImpl, { GITHUB_TOKEN: "t" }),
        runtimes: { opencode: async () => runtime.plugin },
      });
      expect(result.code).toBe(code);
      await record(name, result.json, [], f.summary());
    };
    await again(reviewer({ fail: true }), "rereview-1-failed", 2);
    await again(reviewer(), "rereview-2-retried", 0);
    f.push({ "b.ts": "export const b = 1;\nexport const c = 2;\n" });
    await again(reviewer(), "rereview-3-incremental", 0);
    f.push({ "a.ts": "export const a = 2;\n" });
    await again(reviewer({ silent: true }), "rereview-4-fixed", 0);
  });
});

function bodyOf(call: { body?: unknown } | undefined): string {
  const body = (call?.body as { body?: string } | undefined)?.body;
  if (body === undefined) throw new Error("no summary was published");
  return body;
}

function heads(head: string): Replacements {
  return [
    [head, "<head>"],
    [head.slice(0, 7), "<head7>"],
  ];
}

function platformDeps(
  cwd: string,
  fetchImpl: typeof fetch,
  env: Record<string, string>,
): ReviewDeps {
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
