import { describe, expect, it } from "vitest";
import type { AgentRuntime, Usage } from "../contracts.js";
import type { ReviewEvent } from "../report/report.js";
import { finding, runtime, twoFiles, vcs } from "./run.fakes.js";
import { reviewWithHooks } from "./run.js";

const usage = (costUsd: number): Usage => ({
  inputTokens: 10,
  outputTokens: 2,
  reasoningTokens: 1,
  cachedTokens: 4,
  costUsd,
});

// One finding per file at $0.25 a task; Verify confirms it and the judge
// changes nothing, each for $0.01.
function pricedRuntime() {
  const rt = runtime(async function* (spec) {
    // One file per bundle, in order: task correctness-1 reviews src/a.ts.
    const file = spec.taskId.endsWith("-1") ? "src/a.ts" : "src/b.ts";
    yield {
      type: "finding",
      taskId: spec.taskId,
      finding: finding(file, file === "src/a.ts" ? "const a = 1;" : "const b = 2;"),
    };
    yield { type: "usage", taskId: spec.taskId, ...usage(0.25) };
    yield { type: "done", taskId: spec.taskId };
  });
  const complete: AgentRuntime["complete"] = async (request) => ({
    text: request.tier === "top" ? "{}" : '[{"index":0,"verdict":"confirmed"}]',
    usage: usage(0.01),
  });
  return Object.assign(rt, { complete });
}

async function run() {
  const events: ReviewEvent[] = [];
  const report = await reviewWithHooks({
    vcs: vcs({}, twoFiles),
    runtime: pricedRuntime(),
    bundling: { groupingMinFiles: 10, maxFilesPerBundle: 1, maxBundleChars: 1_000_000 },
    onEvent: (e) => events.push(e),
  });
  return { events, report };
}

describe("a run's progress events", () => {
  it("name every stage once, in order", async () => {
    const { events } = await run();
    const stages = events.flatMap((e) => (e.type === "stage_started" ? [e.stage] : []));
    expect(stages).toEqual(["select", "bundle", "plan", "review", "filter", "verify", "judge"]);
  });

  it("give each file's last state before Verify starts, as the report records it", async () => {
    const { events, report } = await run();
    const settled = events.findIndex((e) => e.type === "coverage_settled");
    const verify = events.findIndex((e) => e.type === "stage_started" && e.stage === "verify");
    expect(settled).toBeGreaterThan(-1);
    expect(settled).toBeLessThan(verify);
    expect(events[settled]).toEqual({ type: "coverage_settled", coverage: report.coverage });
  });

  it("report every model call's spend, adding up to the run's usage", async () => {
    const { events, report } = await run();
    const spent = events.flatMap((e) => (e.type === "usage_reported" ? [e.usage] : []));
    const sum = (key: keyof Usage) => spent.reduce((total, u) => total + u[key], 0);
    expect(report.usage.costUsd).toBeGreaterThan(0.5);
    expect(sum("costUsd")).toBeCloseTo(report.usage.costUsd, 9);
    expect(sum("inputTokens")).toBe(report.usage.inputTokens);
    expect(sum("outputTokens")).toBe(report.usage.outputTokens);
  });
});
