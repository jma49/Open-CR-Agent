import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeOcra, instance } from "./fake-ocra.fakes.js";
import { renderMarkdown } from "./report.js";
import { UnavailableCommitError } from "./repos.js";
import { runInstances } from "./runner.js";
import { score } from "./score.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-runner-"));
  dirs.push(dir);
  return dir;
}

describe("runInstances", () => {
  it("keeps what each review recorded it was made with", async () => {
    const dir = temp();
    const options = {
      runDir: join(dir, "run"),
      reposDir: dir,
      command: [process.execPath, fakeOcra(dir)],
      timeoutMs: 30_000,
      prepare: async () => dir,
      log: () => {},
    };
    const [sampled] = await runInstances([instance("s@1")], {
      ...options,
      reviewArgs: ["--temperature", "0", "--seed", "1"],
    });
    expect(sampled?.provenance).toEqual({
      ocraVersion: "9.9.9",
      promptHash: "p1",
      configHash: "c1",
      sampling: { temperature: 0, notApplied: ["seed"] },
      agents: { correctness: { tier: "standard", models: ["anthropic/claude-haiku-5-5"] } },
    });
    const [plain] = await runInstances([instance("p@1")], options);
    expect(plain).not.toHaveProperty("provenance");
  });

  it("keeps each review's session log next to its result, for the recall funnel", async () => {
    const dir = temp();
    const options = {
      runDir: join(dir, "run"),
      reposDir: dir,
      command: [process.execPath, fakeOcra(dir)],
      timeoutMs: 30_000,
      prepare: async () => dir,
      log: () => {},
    };
    await runInstances(
      [instance("kept", "session:20261008T000000Z-abcdef"), instance("odd", "session:..")],
      options,
    );
    expect(readFileSync(join(dir, "run", "events", "kept.jsonl"), "utf8")).toBe(
      '{"type":"run_started"}\n',
    );
    // A run id that is not one names no session directory.
    expect(() => readFileSync(join(dir, "run", "events", "odd.jsonl"))).toThrow(/ENOENT/);
  });

  it("keeps how a task that never called task_done ended (#477)", async () => {
    const dir = temp();
    const [result] = await runInstances([instance("s@1", "steps")], {
      runDir: join(dir, "run"),
      reposDir: dir,
      command: [process.execPath, fakeOcra(dir)],
      timeoutMs: 30_000,
      prepare: async () => dir,
      log: () => {},
    });
    expect(result?.tasks).toEqual([
      { taskId: "correctness-1", status: "completed", ended: "step_cap" },
    ]);
  });

  it("counts an interrupted or timed-out review as failed, not reviewed", async () => {
    const dir = temp();
    const [result] = await runInstances([instance("x@1", "interrupted")], {
      runDir: join(dir, "run"),
      reposDir: dir,
      command: [process.execPath, fakeOcra(dir)],
      timeoutMs: 30_000,
      prepare: async () => dir,
      log: () => {},
    });
    expect(result).toMatchObject({ status: "failed", exitCode: 130 });
  });

  it("runs a PR again whose saved result cannot be read, saying so", async () => {
    const dir = temp();
    const logs: string[] = [];
    const options = {
      runDir: join(dir, "run"),
      reposDir: join(dir, "repos"),
      command: [process.execPath, fakeOcra(dir)],
      timeoutMs: 30_000,
      prepare: async () => dir,
      log: (message: string) => logs.push(message),
    };
    await runInstances([instance("a")], options);
    writeFileSync(join(dir, "run", "instances", "a.json"), '{"id": "a", "stat');
    const [again] = await runInstances([instance("a")], options);
    expect(again?.status).toBe("reviewed");
    expect(readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(logs.some((l) => l.startsWith("a: running again:") && l.includes("a.json"))).toBe(true);
  });

  it("reviews, records failures, stops at the budget and resumes without repeating work", async () => {
    const dir = temp();
    const options = {
      runDir: join(dir, "run"),
      reposDir: join(dir, "repos"),
      command: [process.execPath, fakeOcra(dir)],
      timeoutMs: 30_000,
      maxCostUsd: 0.9,
      prepare: async () => dir,
      log: () => {},
    };
    const instances = [instance("a"), instance("b", "fail"), instance("c"), instance("d")];

    const first = await runInstances(instances, options);
    expect(first.map((r) => r.status)).toEqual([
      "reviewed",
      "failed",
      "reviewed",
      "skipped_budget",
    ]);
    expect(first[1]?.error).toContain("boom");

    const second = await runInstances(instances, { ...options, maxCostUsd: 5 });
    expect(second.map((r) => r.status)).toEqual(["reviewed", "failed", "reviewed", "reviewed"]);
    expect(readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n")).toEqual([
      "base",
      "fail",
      "base",
      "base",
    ]);

    const retried = await runInstances(instances, { ...options, maxCostUsd: 5, retryFailed: true });
    expect(retried.map((r) => r.status)).toEqual(["reviewed", "failed", "reviewed", "reviewed"]);
    expect(readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n")).toHaveLength(5);

    const summary = await score(instances, second, { sameIssue: async (a, b) => b.startsWith(a) });
    expect(summary.instances).toEqual({
      selected: 4,
      reviewed: 3,
      failed: 1,
      unavailable: 0,
      skippedBudget: 0,
      skippedQuota: 0,
    });
    expect(summary.overall.counts).toEqual({
      expected: 6,
      generated: 3,
      lineMatches: 3,
      semanticMatches: 3,
      lenientMatches: 3,
    });
    expect(summary.overall.metrics).toMatchObject({ precision: 1, recall: 0.5 });
    expect(summary.recallByContext).toEqual({
      "Diff Level": { expected: 3, matched: 3, recall: 1 },
      "File Level": { expected: 3, matched: 0, recall: 0 },
    });
    expect(summary.usage.costUsd).toBeCloseTo(1.5);

    const markdown = renderMarkdown(
      {
        runId: "r",
        createdAt: "now",
        selection: { seed: 1 },
        models: { standard: "m" },
        judge: "test",
      },
      summary,
    );
    expect(markdown).toContain("| 100.0% | 50.0% | 66.7% |");
    expect(markdown).toContain(
      "3 reviewed, 1 failed, 0 unavailable in the dataset, 0 skipped for budget, 0 skipped for spent quota (of 4)",
    );
    expect(markdown).not.toContain("Review flags");
    const flagged = renderMarkdown(
      {
        runId: "r",
        createdAt: "now",
        selection: { seed: 1 },
        models: { standard: "m" },
        judge: "test",
        review: ["--ultra", "--reviewers", "correctness"],
      },
      {
        ...summary,
        judgeUsage: {
          questions: 9,
          fromCache: 4,
          unusable: 1,
          requests: 6,
          inputTokens: 1200,
          cachedTokens: 0,
          outputTokens: 30,
          reasoningTokens: 20,
        },
      },
    );
    expect(flagged).toContain("- Review flags: --ultra --reviewers correctness");
    expect(flagged).toContain(
      "- Judge: 9 question(s), 4 from the cache, 6 request(s); 1200 tokens in (0 cached), 30 out, 20 reasoning; 1 unusable answer(s) scored as no match",
    );
  });

  it("marks PRs whose commits can no longer be fetched as unavailable, not failed", async () => {
    const dir = temp();
    const results = await runInstances([instance("gone")], {
      runDir: join(dir, "run"),
      reposDir: join(dir, "repos"),
      command: [process.execPath, fakeOcra(dir)],
      timeoutMs: 30_000,
      prepare: async () => {
        throw new UnavailableCommitError("commit abc is not available");
      },
      log: () => {},
    });
    expect(results[0]).toMatchObject({
      status: "unavailable",
      error: "commit abc is not available",
    });
    const summary = await score([instance("gone")], results, { sameIssue: async () => true });
    expect(summary.instances).toMatchObject({ reviewed: 0, failed: 0, unavailable: 1 });
    expect(summary.overall.counts.expected).toBe(0);
  });
});
