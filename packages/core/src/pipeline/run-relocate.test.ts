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
    expect(report.anchoring).toEqual({
      byMethod: { hunk: 0, file: 0, cross_file: 0, relocated: 1, file_level: 0 },
      ambiguous: 0,
      relocationCalls: 1,
    });
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

  it("stops relocating once the spend limit is reached", async () => {
    let calls = 0;
    const paraphrasing: AgentRuntime = {
      ...runtime,
      async *runTask(spec) {
        for (const title of ["one", "two", "three"]) {
          yield {
            type: "finding",
            taskId: spec.taskId,
            finding: finding("src/a.ts", `retries ${title}`, { title }),
          };
        }
        yield { type: "done", taskId: spec.taskId };
      },
      complete: async (request) => {
        if (request.system.includes("You locate the code")) calls += 1;
        return runtime.complete?.(request, new AbortController().signal) as ReturnType<
          NonNullable<AgentRuntime["complete"]>
        >;
      },
    };
    const report = await runReview({
      vcs: vcs({}, patch("src/a.ts", "const retries = -1;")),
      runtime: paraphrasing,
      verify: false,
      judge: false,
      maxCostUsd: 0.6,
    });
    expect(calls).toBe(2);
    expect(report.findings.map((f) => f.anchor.method).sort()).toEqual([
      "file_level",
      "relocated",
      "relocated",
    ]);
  });

  it("does not relocate a quote on a file outside the task's bundle", async () => {
    let calls = 0;
    const elsewhere: AgentRuntime = {
      ...runtime,
      async *runTask(spec) {
        if (spec.userPrompt.includes('path="src/a.ts"')) {
          yield {
            type: "finding",
            taskId: spec.taskId,
            finding: finding("src/b.ts", "retries is set to minus one"),
          };
        }
        yield { type: "done", taskId: spec.taskId };
      },
      complete: async (request) => {
        if (request.system.includes("You locate the code")) calls += 1;
        return { text: "{}", usage: { ...usage, costUsd: 0 } };
      },
    };
    await runReview({
      vcs: vcs(
        {},
        [patch("src/a.ts", "const retries = -1;"), patch("src/b.ts", "const b = 2;")].join("\n"),
      ),
      runtime: elsewhere,
      verify: false,
      judge: false,
      bundling: { groupingMinFiles: 100, maxFilesPerBundle: 1, maxBundleChars: 100_000 },
    });
    expect(calls).toBe(0);
  });
});
