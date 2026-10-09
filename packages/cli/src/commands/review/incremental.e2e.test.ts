import type { ReviewReport } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { uploadOf } from "../../cloud/upload.js";
import { run } from "../../run.js";
import { BUILTIN_PLUGINS } from "../review.js";
import type { ReviewDeps } from "./deps.js";
import { movingPullRequest, removePullRequests, reviewer } from "./incremental.fakes.js";

afterEach(removePullRequests);

async function review(
  f: ReturnType<typeof movingPullRequest>,
  runtime: ReturnType<typeof reviewer>,
  extra: string[] = [],
): Promise<ReviewReport> {
  const out = { text: "", write: (c: string) => (out.text += c) };
  const deps: ReviewDeps = {
    cwd: f.clone,
    env: { GITHUB_TOKEN: "t" },
    builtinPlugins: BUILTIN_PLUGINS,
    runtimes: { opencode: async () => runtime.plugin },
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
    const f = movingPullRequest();
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

  it("plans what the next review would cover, and says so", async () => {
    const f = movingPullRequest();
    await review(f, reviewer());
    f.push({ "b.ts": "export const b = 1;\nexport const c = 2;\n" });
    const plan = async (...extra: string[]) => {
      const out = { text: "", write: (c: string) => (out.text += c) };
      const deps: ReviewDeps = {
        cwd: f.clone,
        env: { GITHUB_TOKEN: "t" },
        builtinPlugins: BUILTIN_PLUGINS,
        runtimes: {},
        now: Date.now,
        heartbeatMs: 60_000,
        fetch: f.fetchImpl,
      };
      await run(["review", "--pr", "7", "--repo", "o/r", "--plan", ...extra], out, out, deps);
      return out.text;
    };
    const json = JSON.parse(await plan("--format", "json"));
    expect(json.scope).toMatchObject({ mode: "incremental" });
    expect(json.tasks.map((t: { files: string[] }) => t.files)).toEqual([["b.ts"]]);
    expect(await plan()).toMatch(/^Reviews only what changed since [0-9a-f]{7}\.$/m);
    const full = JSON.parse(await plan("--full", "--format", "json"));
    expect(full.scope).toEqual({ mode: "full", reason: "a full review was requested" });
  });

  it("credits a fix to the reviewer of the finding the earlier review published", async () => {
    const f = movingPullRequest();
    const first = await review(f, reviewer());
    const reporter = first.findings.find((x) => x.file === "a.ts")?.reviewer;
    expect(reporter).toBeDefined();

    f.push({ "a.ts": "export const a = 2;\n" });
    const second = await review(f, reviewer({ silent: true }));
    expect(second.findings).toEqual([]);
    expect(second.rereview?.fixed.map((x) => [x.file, x.reviewer])).toEqual([["a.ts", reporter]]);
    // Gone from this report, the finding still counts for its reviewer.
    const counts = uploadOf(second, "github", "f".repeat(64), 1).reviewers ?? {};
    expect(counts[reporter as string]).toMatchObject({ fixed: 1 });
  });

  it("reviews everything again after a force-push and says why", async () => {
    const f = movingPullRequest();
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
    const f = movingPullRequest();
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
