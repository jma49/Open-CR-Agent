import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Instance } from "./dataset.js";
import { renderMarkdown } from "./report.js";
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
const finding = { id: "1", fingerprint: "f", reviewer: "correctness", category: "correctness", severity: "warning",
  file: "src/a.ts", existingCode: "x", title: "Null dereference", body: "user may be missing", evidence: [],
  lineRange: { start: 10, end: 10 }, anchor: { method: "hunk", inDiff: true }, status: "new" };
writeFileSync(out, JSON.stringify({ findings: [finding], tasks: [{ taskId: "correctness-1", status: "completed" }],
  usage: { inputTokens: 100, outputTokens: 10, reasoningTokens: 0, cachedTokens: 0, costUsd: 0.5 } }));
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

    const summary = await score(instances, second, { sameIssue: async (a, b) => b.startsWith(a) });
    expect(summary.instances).toEqual({ selected: 4, reviewed: 3, failed: 1, skippedBudget: 0 });
    expect(summary.overall.counts).toEqual({
      expected: 6,
      generated: 3,
      lineMatches: 3,
      semanticMatches: 3,
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
    expect(markdown).toContain("3 reviewed, 1 failed, 0 skipped for budget (of 4)");
  });
});
