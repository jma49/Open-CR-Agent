import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Instance } from "./instance.js";
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

// Stands in for `ocra review`: writes a report with one finding at src/a.ts:10
// costing $0.5, or fails when the base commit is "fail".
function fakeOcra(dir: string): string {
  const script = join(dir, "fake-ocra.mjs");
  writeFileSync(
    script,
    `import { writeFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const out = args[args.indexOf("--output") + 1];
appendFileSync(${JSON.stringify(join(dir, "calls.log"))}, args[args.indexOf("--from") + 1] + "\\n");
if (args[args.indexOf("--from") + 1] === "fail") { process.stderr.write("boom\\n"); process.exit(2); }
if (args[args.indexOf("--from") + 1] === "quota") {
  writeFileSync(out, JSON.stringify({ findings: [], tasks: [{ taskId: "correctness-1", status: "failed",
    error: "every standard model failed (google/x: You exceeded your current quota, please check your plan)" }],
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 } }));
  process.exit(2);
}
if (args[args.indexOf("--from") + 1] === "cut") {
  writeFileSync(out, JSON.stringify({ version: 1, findings: [], tasks: [
    { taskId: "performance-1", status: "completed" },
    { taskId: "correctness-1", status: "failed",
      error: "every standard model failed (router/m: Rate limit exceeded: free-models-per-day-stealth.)" }],
    usage: { inputTokens: 50, outputTokens: 5, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 } }));
  process.exit(3);
}
const finding = { fingerprint: "f", reviewer: "correctness", category: "correctness", severity: "warning",
  verification: "unchecked", file: "src/a.ts", code: "x", title: "Null dereference", body: "user may be missing",
  evidence: [], lines: { start: 10, end: 10 }, inDiff: true, status: "new" };
const t = args.indexOf("--temperature");
const provenance = t < 0 ? {} : { provenance: { ocraVersion: "9.9.9", promptHash: "p1", configHash: "c1",
  sampling: { temperature: Number(args[t + 1]), notApplied: ["seed"] } } };
writeFileSync(out, JSON.stringify({ version: 1, findings: [finding], tasks: [{ taskId: "correctness-1", status: "completed" }],
  usage: { inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cachedTokens: 0, costUsd: 0.5 }, ...provenance }));
// Interrupted after one task finished: a partial report and exit 130.
if (args[args.indexOf("--from") + 1] === "interrupted") process.exit(130);
`,
  );
  chmodSync(script, 0o755);
  return script;
}

function instance(id: string, baseCommit = "base"): Instance {
  return {
    id,
    repo: "acme/api",
    prUrl: "https://github.com/acme/api/pull/1",
    language: "TypeScript",
    prCategory: "Bug Fix",
    baseCommit,
    headCommit: "head",
    changeLines: 10,
    references: [
      {
        path: "src/a.ts",
        side: "right",
        fromLine: 10,
        toLine: 11,
        note: "Null dereference",
        category: "Code Defect",
        context: "Diff Level",
      },
      {
        path: "src/b.ts",
        side: "right",
        fromLine: 1,
        toLine: 1,
        note: "Missing await",
        category: "Code Defect",
        context: "File Level",
      },
    ],
  };
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
    });
    const [plain] = await runInstances([instance("p@1")], options);
    expect(plain).not.toHaveProperty("provenance");
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

  it("stops starting PRs once one fails on spent quota, and resumes them later", async () => {
    const dir = temp();
    const logs: string[] = [];
    const options = {
      runDir: join(dir, "run"),
      reposDir: join(dir, "repos"),
      command: [process.execPath, fakeOcra(dir)],
      timeoutMs: 30_000,
      prepare: async () => dir,
      log: (m: string) => logs.push(m),
    };
    const instances = [instance("a"), instance("b", "quota"), instance("c"), instance("d")];
    const first = await runInstances(instances, options);
    expect(first.map((r) => r.status)).toEqual([
      "reviewed",
      "failed",
      "skipped_quota",
      "skipped_quota",
    ]);
    expect(logs).toContain(
      "the model quota is spent; the remaining PRs are skipped (rerun later to resume)",
    );

    const later = await runInstances(instances, options);
    expect(later.map((r) => r.status)).toEqual(["reviewed", "failed", "reviewed", "reviewed"]);
  });

  it("treats a review that lost tasks to the quota as spent quota, and reviews it again only on --retry-failed", async () => {
    const dir = temp();
    const options = {
      runDir: join(dir, "run"),
      reposDir: join(dir, "repos"),
      command: [process.execPath, fakeOcra(dir)],
      timeoutMs: 30_000,
      prepare: async () => dir,
      log: () => {},
    };
    const instances = [instance("a"), instance("b", "cut"), instance("c")];
    const first = await runInstances(instances, options);
    expect(first.map((r) => r.status)).toEqual(["reviewed", "reviewed", "skipped_quota"]);
    expect(first[1]).toMatchObject({ exitCode: 3 });

    const resumed = await runInstances(instances, options);
    expect(resumed.map((r) => r.status)).toEqual(["reviewed", "reviewed", "reviewed"]);
    const calls = () => readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");
    // The cut review is kept as it is; c is reviewed.
    expect(calls()).toEqual(["base", "cut", "base"]);

    await runInstances(instances, { ...options, retryFailed: true });
    expect(calls()).toEqual(["base", "cut", "base", "cut"]);
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
      summary,
    );
    expect(flagged).toContain("- Review flags: --ultra --reviewers correctness");
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
