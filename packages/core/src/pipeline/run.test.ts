import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentRuntime, AgentTaskSpec, VcsAdapter } from "../contracts.js";
import { parseUnifiedDiff } from "../diff/parse.js";
import type { ReportedFinding } from "../domain.js";
import type { ReviewEvent } from "./report.js";
import { runReview } from "./run.js";

function patch(path: string, added: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1,2 @@",
    " keep",
    `+${added}`,
  ].join("\n");
}

function vcs(files: Record<string, string>, diffText: string): VcsAdapter {
  return {
    name: "fake",
    getChangeRequest: async () => ({
      id: "1",
      title: "t",
      description: "d",
      baseSha: "b",
      headSha: "h",
    }),
    getDiff: async () => parseUnifiedDiff(diffText),
    readFile: async (path) => files[path],
    searchCode: async () => [],
    getPriorReview: async () => undefined,
    publish: async () => {},
  };
}

type Script = (spec: AgentTaskSpec, signal: AbortSignal) => AsyncIterable<AgentEvent>;

function runtime(script: Script): AgentRuntime & { specs: AgentTaskSpec[] } {
  const specs: AgentTaskSpec[] = [];
  return {
    name: "fake",
    specs,
    runTask(spec, signal) {
      specs.push(spec);
      return script(spec, signal);
    },
  };
}

function finding(
  file: string,
  existingCode: string,
  overrides: Partial<ReportedFinding> = {},
): ReportedFinding {
  return {
    category: "correctness",
    severity: "warning",
    file,
    existingCode,
    title: "t",
    body: "b",
    evidence: [],
    ...overrides,
  };
}

const twoFiles = [patch("src/a.ts", "const a = 1;"), patch("src/b.ts", "const b = 2;")].join("\n");

describe("runReview", () => {
  it("reviews selected files end to end and anchors findings", async () => {
    const rt = runtime(async function* (spec) {
      yield { type: "progress", taskId: spec.taskId, message: "reading" };
      yield { type: "finding", taskId: spec.taskId, finding: finding("src/b.ts", "const b = 2;") };
      yield {
        type: "usage",
        taskId: spec.taskId,
        inputTokens: 100,
        outputTokens: 10,
        reasoningTokens: 5,
        cachedTokens: 80,
        costUsd: 0.002,
      };
      yield { type: "done", taskId: spec.taskId };
    });
    const events: ReviewEvent[] = [];
    const report = await runReview({
      vcs: vcs({}, twoFiles),
      runtime: rt,
      onEvent: (e) => events.push(e),
    });

    expect(rt.specs).toHaveLength(1);
    expect(report.bundles).toEqual([
      { label: "small change set", files: ["src/a.ts", "src/b.ts"] },
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      file: "src/b.ts",
      lineRange: { start: 2, end: 2 },
      anchor: { method: "hunk", inDiff: true },
      reviewer: "correctness",
      status: "new",
    });
    expect(report.coverage.map((c) => c.status)).toEqual(["reviewed", "reviewed"]);
    expect(report.usage).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      reasoningTokens: 5,
      cachedTokens: 80,
      costUsd: 0.002,
    });
    expect(events.map((e) => e.type)).toEqual([
      "run_started",
      "files_selected",
      "files_bundled",
      "task_started",
      "task_progress",
      "finding",
      "task_finished",
      "run_finished",
    ]);
  });

  it("records excluded files in coverage with their reason", async () => {
    const diff = [twoFiles, patch("package-lock.json", "{}")].join("\n");
    const rt = runtime(async function* (spec) {
      yield { type: "done", taskId: spec.taskId };
    });
    const report = await runReview({ vcs: vcs({}, diff), runtime: rt });
    expect(report.coverage.at(-1)).toEqual({
      path: "package-lock.json",
      status: "excluded",
      reason: "generated",
    });
  });

  it("puts repository guidelines and matching rules into the prompt", async () => {
    const files = {
      "AGENTS.md": "Always run npm run verify.",
      ".ocra/rules.json": JSON.stringify({
        rules: [{ path: "src/**", rule: "Check tenant ids." }],
      }),
    };
    const rt = runtime(async function* (spec) {
      yield { type: "done", taskId: spec.taskId };
    });
    await runReview({ vcs: vcs(files, twoFiles), runtime: rt });
    expect(rt.specs[0]?.userPrompt).toContain("Always run npm run verify.");
    expect(rt.specs[0]?.userPrompt).toContain("Check tenant ids.");
    expect(rt.specs[0]?.modelTier).toBe("standard");
  });

  it("combines plugin rules with repository rules", async () => {
    const rt = runtime(async function* (spec) {
      yield { type: "done", taskId: spec.taskId };
    });
    await runReview({
      vcs: vcs({}, twoFiles),
      runtime: rt,
      rules: [{ path: "src/**", rule: "Plugin rule." }],
    });
    expect(rt.specs[0]?.userPrompt).toContain("Plugin rule.");
  });

  it("refuses to run without reviewers", async () => {
    const rt = runtime(async function* () {});
    await expect(runReview({ vcs: vcs({}, twoFiles), runtime: rt, reviewers: [] })).rejects.toThrow(
      "No reviewer is registered",
    );
  });

  it("fails loudly on an invalid rules file", async () => {
    const rt = runtime(async function* () {});
    await expect(
      runReview({ vcs: vcs({ ".ocra/rules.json": "{" }, twoFiles), runtime: rt }),
    ).rejects.toThrow("not valid JSON");
  });

  it("keeps other tasks and partial findings when one task fails", async () => {
    const diff = ["a", "b", "c", "d"]
      .map((n) => patch(`src/${n}.ts`, `const ${n} = 1;`))
      .join("\n");
    const rt = runtime(async function* (spec) {
      if (spec.taskId === "correctness-2") {
        yield {
          type: "finding",
          taskId: spec.taskId,
          finding: finding("src/b.ts", "const b = 1;"),
        };
        yield { type: "error", taskId: spec.taskId, error: "rate limited", retryable: true };
        return;
      }
      if (spec.taskId === "correctness-3") throw new Error("crashed");
      yield { type: "done", taskId: spec.taskId };
    });
    const report = await runReview({ vcs: vcs({}, diff), runtime: rt });
    expect(report.tasks.map((t) => [t.taskId, t.status, t.error])).toEqual([
      ["correctness-1", "completed", undefined],
      ["correctness-2", "failed", "rate limited"],
      ["correctness-3", "failed", "crashed"],
      ["correctness-4", "completed", undefined],
    ]);
    expect(report.coverage.map((c) => c.status)).toEqual([
      "reviewed",
      "failed",
      "failed",
      "reviewed",
    ]);
    expect(report.findings).toHaveLength(1);
  });

  it("times out tasks whose runtime stops responding", async () => {
    const rt = runtime(async function* () {
      await new Promise(() => {});
    });
    const report = await runReview({ vcs: vcs({}, twoFiles), runtime: rt, taskTimeoutMs: 20 });
    expect(report.tasks[0]).toMatchObject({ status: "timed_out", error: "timed out after 20ms" });
  });

  it("cancels tasks when the caller aborts the run", async () => {
    const controller = new AbortController();
    const rt = runtime(async function* () {
      controller.abort();
      await new Promise(() => {});
    });
    const report = await runReview({
      vcs: vcs({}, twoFiles),
      runtime: rt,
      signal: controller.signal,
    });
    expect(report.tasks[0]).toMatchObject({ status: "cancelled", error: "run cancelled" });
  });

  it("drops invalid findings with a warning and deduplicates repeated ones", async () => {
    const rt = runtime(async function* (spec) {
      yield {
        type: "finding",
        taskId: spec.taskId,
        finding: { ...finding("src/a.ts", "x"), severity: "fatal" } as never,
      };
      yield { type: "finding", taskId: spec.taskId, finding: finding("src/a.ts", "const a = 1;") };
      yield {
        type: "finding",
        taskId: spec.taskId,
        finding: finding("src/a.ts", "  const a   = 1;", { severity: "critical" }),
      };
      yield { type: "done", taskId: spec.taskId };
    });
    const report = await runReview({ vcs: vcs({}, twoFiles), runtime: rt });
    expect(report.warnings).toEqual(["runtime reported a finding that failed validation"]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.severity).toBe("critical");
  });

  it("reads the reviewed revision through the task context", async () => {
    const rt = runtime(async function* (spec) {
      const content = await spec.context.readFile("src/a.ts");
      yield { type: "progress", taskId: spec.taskId, message: String(content) };
      yield {
        type: "progress",
        taskId: spec.taskId,
        message: String(spec.context.readDiff("src/b.ts")?.length),
      };
      yield { type: "done", taskId: spec.taskId };
    });
    const messages: string[] = [];
    await runReview({
      vcs: vcs({ "src/a.ts": "head content" }, twoFiles),
      runtime: rt,
      onEvent: (e) => e.type === "task_progress" && messages.push(e.message),
    });
    expect(messages[0]).toBe("head content");
    expect(Number(messages[1])).toBeGreaterThan(0);
  });
});
