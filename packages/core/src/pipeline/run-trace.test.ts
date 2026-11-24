import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "../contracts.js";
import { REVIEW_TOOLS } from "../review/tools.js";
import { ChainRunner } from "../runtime/chain-runner.js";
import { finding, twoFiles, vcs } from "./run.fakes.js";
import { review } from "./run.js";

const usage = {
  inputTokens: 40,
  outputTokens: 9,
  reasoningTokens: 0,
  cachedTokens: 8,
  costUsd: 0.01,
};
const walkthrough = JSON.stringify({
  overview: "Adds two constants.",
  groups: [{ title: "Constants", files: ["src/a.ts", "src/b.ts"], note: "One each." }],
});

// Every review attempt reads both files, searches once and reports one
// finding; every plain completion answers the walkthrough.
function tracedRun(): AgentRuntime {
  const runner = new ChainRunner(
    { standard: ["p/review"], light: ["p/light"], top: ["p/top"] },
    {
      task: async () => ({
        steps: 4,
        toolCalls: [
          REVIEW_TOOLS.readFile,
          REVIEW_TOOLS.readFile,
          REVIEW_TOOLS.codeSearch,
          REVIEW_TOOLS.reportFinding,
          REVIEW_TOOLS.taskDone,
        ],
        read: ["src/a.ts", "src/b.ts"],
        searched: ["secretLiteral("],
        text: "the answer text",
        findings: [finding("src/a.ts", "const a = 1;", { title: "a is never read" })],
        usage,
      }),
      complete: async () => ({ steps: 1, toolCalls: [], text: walkthrough, findings: [], usage }),
    },
  );
  return {
    name: "fake",
    runTask: (spec, signal) => runner.runTask(spec, signal),
    complete: (request, signal) => runner.complete(request, signal),
  };
}

describe("a review's trace", () => {
  it("lays out each task's attempts, the plain calls and the findings' fates", async () => {
    const report = await review({
      vcs: vcs({}, twoFiles),
      runtime: tracedRun(),
      stages: { verify: false, judge: false, walkthrough: true },
    });
    const trace = report.trace;
    expect(trace?.stages.map((s) => s.stage)).toContain("review");
    expect(trace?.tasks).toHaveLength(1);
    expect(trace?.tasks[0]).toMatchObject({ status: "completed", reviewer: "correctness" });
    expect(trace?.tasks[0]?.attempts).toEqual([
      expect.objectContaining({
        model: "p/review",
        steps: 4,
        tools: { read_file: 2, code_search: 1, report_finding: 1, task_done: 1 },
        ending: "done",
        read: ["src/a.ts", "src/b.ts"],
        searches: 1,
        usage,
      }),
    ]);
    expect(trace?.calls).toContainEqual(
      expect.objectContaining({ agent: "writer", model: expect.any(String), usage }),
    );
    expect(trace?.findings).toEqual([
      expect.objectContaining({ title: "a is never read", file: "src/a.ts", fate: "kept" }),
    ]);
  });

  it("keeps no code, prompt or answer text", async () => {
    const report = await review({
      vcs: vcs({}, twoFiles),
      runtime: tracedRun(),
      stages: { verify: false, judge: false },
    });
    const trace = JSON.stringify(report.trace);
    expect(trace).toContain("a is never read");
    expect(trace).not.toContain("secretLiteral(");
    expect(trace).not.toContain("the answer text");
    expect(trace).not.toContain("const a = 1;");
  });
});
