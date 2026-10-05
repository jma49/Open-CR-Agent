import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "../contracts.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import { REVIEW_TOOLS } from "../review/tools.js";
import { type AttemptOutcome, MAX_AGENT_STEPS } from "../runtime/attempt.js";
import { ChainRunner } from "../runtime/chain-runner.js";
import { twoFiles, vcs } from "./run.fakes.js";
import { review } from "./run.js";

const usage = { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 };
const reviewer: ReviewerDefinition = {
  id: "correctness",
  category: "correctness",
  modelTier: "standard",
  systemPrompt: "",
};

// A runtime whose every review attempt comes to `attempt`, through the
// ChainRunner the real runtimes use.
function runtimeEnding(attempt: Omit<AttemptOutcome, "usage" | "findings">): AgentRuntime {
  const runner = new ChainRunner(
    { standard: ["p/m"] },
    {
      task: async () => ({ ...attempt, findings: [], usage }),
      complete: async () => ({ steps: 1, toolCalls: [], text: "", findings: [], usage }),
    },
  );
  return { name: "fake", runTask: (spec, signal) => runner.runTask(spec, signal) };
}

const reviewWith = (runtime: AgentRuntime) =>
  review({
    vcs: vcs({}, twoFiles),
    runtime,
    reviewers: [reviewer],
    stages: { verify: false, judge: false },
  });

describe("how a review task ended", () => {
  it("does not count the files of a task cut off at the step cap as reviewed", async () => {
    const report = await reviewWith(
      runtimeEnding({
        steps: MAX_AGENT_STEPS,
        toolCalls: Array.from({ length: MAX_AGENT_STEPS }, () => REVIEW_TOOLS.readFile),
        text: "",
        atStepCap: true,
      }),
    );
    expect(report.tasks.map((t) => [t.status, t.ended])).toEqual([["completed", "step_cap"]]);
    expect(report.coverage).toEqual([
      { path: "src/a.ts", status: "incomplete", ended: "step_cap" },
      { path: "src/b.ts", status: "incomplete", ended: "step_cap" },
    ]);
  });

  it("does not count the files of a task that stopped early without task_done", async () => {
    const report = await reviewWith(
      runtimeEnding({ steps: 2, toolCalls: [REVIEW_TOOLS.readDiff], text: "", resumed: true }),
    );
    expect(report.tasks.map((t) => t.ended)).toEqual(["stopped_early"]);
    expect(report.coverage.map((c) => c.status)).toEqual(["incomplete", "incomplete"]);
  });

  it("counts the files of a task that called task_done as reviewed", async () => {
    const report = await reviewWith(
      runtimeEnding({
        steps: 3,
        toolCalls: [REVIEW_TOOLS.readDiff, REVIEW_TOOLS.taskDone],
        text: "",
      }),
    );
    expect(report.tasks[0]).not.toHaveProperty("ended");
    expect(report.coverage.map((c) => c.status)).toEqual(["reviewed", "reviewed"]);
  });
});
