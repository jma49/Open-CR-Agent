import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeOcra, instance, REFUSALS } from "./fake-ocra.fakes.js";
import { renderMarkdown } from "./report.js";
import { type RunOptions, runInstances } from "./runner.js";
import { score } from "./score.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A run of the fake ocra in a directory of its own: what it logs, and the
// base commit of every review it was asked for.
function setup(): { dir: string; options: RunOptions; logs: string[]; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "ocra-runner-"));
  dirs.push(dir);
  const logs: string[] = [];
  const options: RunOptions = {
    runDir: join(dir, "run"),
    reposDir: join(dir, "repos"),
    command: [process.execPath, fakeOcra(dir)],
    timeoutMs: 30_000,
    prepare: async () => dir,
    log: (message) => logs.push(message),
  };
  const calls = () => readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");
  return { dir, options, logs, calls };
}

describe("runInstances and the provider's limits", () => {
  it("stops starting PRs once one fails on spent quota, and resumes them later", async () => {
    const { options, logs } = setup();
    const instances = [instance("a"), instance("b", "quota"), instance("c"), instance("d")];
    const first = await runInstances(instances, options);
    expect(first.map((r) => r.status)).toEqual([
      "reviewed",
      "failed",
      "skipped_quota",
      "skipped_quota",
    ]);
    expect(logs).toContain(
      "the model's credit or quota is spent (every standard model failed (google/x: You exceeded your current quota, please check your plan)); the remaining PRs are skipped (rerun later to resume)",
    );

    const later = await runInstances(instances, options);
    expect(later.map((r) => r.status)).toEqual(["reviewed", "failed", "reviewed", "reviewed"]);
  });

  it.each(["credit", "spend-limit"] as const)(
    "stops the run at once when the provider refuses for %s",
    async (refusal) => {
      const { options, logs, calls } = setup();
      const instances = [instance("a"), instance("b", `refused:${refusal}`), instance("c")];
      const results = await runInstances(instances, options);
      expect(results.map((r) => r.status)).toEqual(["reviewed", "failed", "skipped_quota"]);
      expect(results[1]?.cutShortBy).toEqual(["quota"]);
      expect(calls()).toEqual(["base", `refused:${refusal}`]);
      expect(logs.join("\n")).toContain(
        `the model's credit or quota is spent (every standard model failed (${REFUSALS[refusal]}))`,
      );
    },
  );

  it.each(["vertex", "per-minute", "overloaded"] as const)(
    "fails a PR that lost tasks to a rate limit (%s) and reviews the next",
    async (refusal) => {
      const { options, logs, calls } = setup();
      const instances = [instance("a"), instance("b", `lost:${refusal}`), instance("c")];
      const first = await runInstances(instances, options);
      expect(first.map((r) => r.status)).toEqual(["reviewed", "failed", "reviewed"]);
      expect(first[1]).toMatchObject({ exitCode: 3, cutShortBy: ["rate_limit"] });
      expect(first[1]?.error).toContain("tasks lost to the provider's rate limit");
      expect(logs.join("\n")).not.toContain("is spent");

      await runInstances(instances, options);
      expect(calls()).toEqual(["base", `lost:${refusal}`, "base"]);
      await runInstances(instances, { ...options, retryFailed: true });
      expect(calls()).toEqual(["base", `lost:${refusal}`, "base", `lost:${refusal}`]);
    },
  );

  it("treats a review that lost tasks to a daily limit as spent quota, and reviews it again only on --retry-failed", async () => {
    const { options, calls } = setup();
    const instances = [instance("a"), instance("b", "cut"), instance("c")];
    const first = await runInstances(instances, options);
    expect(first.map((r) => r.status)).toEqual(["reviewed", "failed", "skipped_quota"]);
    expect(first[1]).toMatchObject({ exitCode: 3, cutShortBy: ["quota"] });

    const resumed = await runInstances(instances, options);
    expect(resumed.map((r) => r.status)).toEqual(["reviewed", "failed", "reviewed"]);
    // The cut review is kept as it is; c is reviewed.
    expect(calls()).toEqual(["base", "cut", "base"]);

    await runInstances(instances, { ...options, retryFailed: true });
    expect(calls()).toEqual(["base", "cut", "base", "cut"]);
  });

  it("resumes a review that lost tasks to the provider instead of paying for it again", async () => {
    const { dir, options, logs } = setup();
    const instances = [instance("a", "resumable")];
    const [first] = await runInstances(instances, options);
    expect(first).toMatchObject({ status: "failed", runId: "run-1" });

    logs.length = 0;
    const [retried] = await runInstances(instances, { ...options, retryFailed: true });
    expect(readFileSync(join(dir, "resumed.log"), "utf8")).toBe("run-1\n");
    expect(retried).toMatchObject({ status: "reviewed", runId: "run-2" });
    // What the PR cost in all: the attempt resumed and the one that resumed it.
    expect(retried?.usage.costUsd).toBeCloseTo(0.5);
    expect(logs.join("\n")).toContain(
      "$0.2000 (resumed run-1, 1 task(s) reused; this PR $0.5000) (total $0.2000)",
    );
    // The funnel reads what the reused task read in run-1, and nothing else of run-1.
    const events = readFileSync(join(dir, "run", "events", "a.jsonl"), "utf8");
    expect(events).toContain('"runId":"run-1"');
    expect(events).toContain('"runId":"run-2"');
    expect(events).toContain("src/perf.ts");
    expect(events).toContain("src/redone.ts");
    expect(events).not.toContain("src/lost.ts");
  });

  it("reviews a lost PR afresh when the earlier session is gone", async () => {
    const { dir, options } = setup();
    const instances = [instance("a", "resumable")];
    await runInstances(instances, options);
    rmSync(join(dir, ".ocra", "sessions", "run-1"), { recursive: true });
    await runInstances(instances, { ...options, retryFailed: true });
    expect(() => readFileSync(join(dir, "resumed.log"), "utf8")).toThrow();
  });
});

describe("runInstances on reviews cut short", () => {
  it("records the per-PR spend cap and the task and run timeouts, and still scores the review", async () => {
    const { options } = setup();
    const [result] = await runInstances([instance("s", "spend-cap")], options);
    expect(result).toMatchObject({
      status: "reviewed",
      exitCode: 3,
      cutShortBy: ["spend_cap", "timeout"],
    });
    const [run] = await runInstances([instance("t", "run-timeout")], options);
    expect(run).toMatchObject({ status: "reviewed", exitCode: 3, cutShortBy: ["timeout"] });
  });

  it("fails a PR its own timeout stopped, with what ocra wrote before it stopped", async () => {
    const { options } = setup();
    const [result] = await runInstances([instance("t", "slow")], { ...options, timeoutMs: 1000 });
    expect(result).toMatchObject({
      status: "failed",
      cutShortBy: ["timeout"],
      error: "timed out after 1s",
    });
    expect(result?.tasks).toEqual([{ taskId: "correctness-1", status: "completed" }]);
  });

  it("reports the share of incomplete reviews and of tasks cut short", async () => {
    const { options } = setup();
    const instances = [
      instance("a"),
      instance("s", "steps"),
      instance("c", "spend-cap"),
      instance("r", "lost:vertex"),
    ];
    const results = await runInstances(instances, options);
    const summary = await score(instances, results, { sameIssue: async () => false });
    expect(summary.truncation).toEqual({
      reviewed: 3,
      incomplete: 2,
      tasks: 6,
      stepCap: 1,
      spendCap: 2,
      timedOut: 1,
      rateLimited: 1,
    });
    const markdown = renderMarkdown(
      { runId: "r", createdAt: "now", selection: { seed: 1 }, models: {}, judge: "test" },
      summary,
    );
    expect(markdown).toContain(
      "- Cut short: 2 of 3 reviewed PR(s) incomplete, exit 3 (66.7%); of their 6 task(s), 1 at the step cap (16.7%), 2 at the spend cap (33.3%), 1 timed out (16.7%); 1 PR(s) failed on the provider's rate limit (--retry-failed reviews them again)",
    );
  });
});
