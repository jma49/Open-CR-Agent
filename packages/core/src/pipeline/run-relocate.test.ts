import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "../contracts.js";
import { finding, patch, vcs } from "./run.fakes.js";
import { runReview } from "./run.js";

const usage = {
  inputTokens: 5,
  outputTokens: 1,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd: 0.5,
};

// The reviewer paraphrases the code; the light model maps it back.
const runtime: AgentRuntime = {
  name: "fake",
  async *runTask(spec) {
    yield {
      type: "finding",
      taskId: spec.taskId,
      finding: finding("src/a.ts", "retries is set to minus one"),
    };
    yield { type: "done", taskId: spec.taskId };
  },
  complete: async (request) =>
    request.system.includes("You locate the code")
      ? { text: "const retries = -1;", usage }
      : { text: "{}", usage: { ...usage, costUsd: 0 } },
};

describe("runReview relocation", () => {
  it("anchors a paraphrased quote through the light model and counts its cost", async () => {
    const report = await runReview({
      vcs: vcs({}, patch("src/a.ts", "const retries = -1;")),
      runtime,
      verify: false,
      judge: false,
    });
    expect(report.findings[0]?.anchor.method).toBe("relocated");
    expect(report.findings[0]?.lineRange).toEqual({ start: 2, end: 2 });
    expect(report.usage.costUsd).toBeCloseTo(0.5);
  });

  it("can be turned off", async () => {
    const report = await runReview({
      vcs: vcs({}, patch("src/a.ts", "const retries = -1;")),
      runtime,
      verify: false,
      judge: false,
      relocate: false,
    });
    expect(report.findings[0]?.anchor.method).toBe("file_level");
  });
});
