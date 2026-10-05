import { describe, expect, it } from "vitest";
import type { AgentRuntime, AgentTaskSpec, Usage } from "../contracts.js";
import { REVIEW_TOOLS } from "../review/tools.js";
import { MAX_AGENT_STEPS, type TaskAttempt } from "../runtime/attempt.js";
import { ChainRunner } from "../runtime/chain-runner.js";
import { finding, patch, vcs } from "./run.fakes.js";
import { reviewWithHooks } from "./run.js";

const usage = (costUsd: number): Usage => ({
  inputTokens: 1,
  outputTokens: 1,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd,
});

const files = (count: number) =>
  Array.from({ length: count }, (_, i) => patch(`src/f${i}.ts`, `const v${i} = 1;`)).join("\n");
const perFile = { groupingMinFiles: 10, maxFilesPerBundle: 1, maxBundleChars: 1_000_000 };

// The file task correctness-<n> reviews, and a finding on it.
const fileOf = (spec: AgentTaskSpec) => Number(spec.taskId.split("-")[1]) - 1;
const findingOf = (spec: AgentTaskSpec, title: string) =>
  finding(`src/f${fileOf(spec)}.ts`, `const v${fileOf(spec)} = 1;`, { title });

interface Attempt {
  spec: AgentTaskSpec;
  model: string;
  signal: AbortSignal;
  onUsage: (spent: Usage) => void;
}

interface Script {
  // The attempt's outcome before any wrap-up turn.
  attempt(a: Attempt): TaskAttempt | Promise<TaskAttempt>;
  // The outcome after the wrap-up turn, given the one before it.
  wrapUp?(a: Attempt, before: TaskAttempt): TaskAttempt | Promise<TaskAttempt>;
}

// A runtime made the way the real ones are: a ChainRunner over attempts the
// test scripts. Records each task that got the wrap-up turn, with its model.
function scriptedRuntime(script: Script, chain = ["fake/m1"]) {
  const wrappedUp: string[] = [];
  const chains = new ChainRunner(
    { top: chain, standard: chain, light: chain },
    {
      task: async (model, spec, signal, onUsage) => {
        const a: Attempt = { spec, model, signal, onUsage };
        const outcome = await script.attempt(a);
        return {
          ...outcome,
          wrapUp: async () => {
            wrappedUp.push(`${spec.taskId} ${model}`);
            const { wrapUp: _, ...after } = await (script.wrapUp?.(a, outcome) ?? outcome);
            return after;
          },
        };
      },
      complete: async () => ({ findings: [], steps: 1, toolCalls: [], text: "", usage: usage(0) }),
    },
  );
  const runtime: AgentRuntime = {
    name: "fake",
    runTask: (spec, signal) => chains.runTask(spec, signal),
  };
  return { runtime, wrappedUp };
}

// A review that used every step reading and called neither report_finding
// nor task_done.
const capped = (costUsd = 0.01): TaskAttempt => ({
  findings: [],
  steps: MAX_AGENT_STEPS,
  toolCalls: Array.from({ length: MAX_AGENT_STEPS }, () => REVIEW_TOOLS.readFile),
  text: "",
  atStepCap: true,
  usage: usage(costUsd),
});

const finished = (spec: AgentTaskSpec): TaskAttempt => ({
  findings: [findingOf(spec, "found")],
  steps: 3,
  toolCalls: [REVIEW_TOOLS.readFile, REVIEW_TOOLS.reportFinding, REVIEW_TOOLS.taskDone],
  text: "",
  usage: usage(0.01),
});

// The wrap-up turn: one finding and the done tool, for `costUsd` more.
const reports =
  (costUsd = 0.01) =>
  ({ spec }: Attempt, before: TaskAttempt): TaskAttempt => ({
    ...before,
    findings: [...before.findings, findingOf(spec, "confirmed before the cap")],
    steps: before.steps + 1,
    toolCalls: [...before.toolCalls, REVIEW_TOOLS.reportFinding, REVIEW_TOOLS.taskDone],
    usage: usage(before.usage.costUsd + costUsd),
  });

const noChecks = { verify: false, judge: false };

describe("a review task that ends without task_done", () => {
  it("gets one reporting-only turn, and what it reports there is kept", async () => {
    const { runtime, wrappedUp } = scriptedRuntime({ attempt: () => capped(), wrapUp: reports() });
    const progress: string[] = [];
    const report = await reviewWithHooks({
      vcs: vcs({}, files(1)),
      runtime,
      stages: noChecks,
      onEvent: (e) => {
        if (e.type === "task_progress") progress.push(e.message);
      },
    });
    expect(wrappedUp).toEqual(["correctness-1 fake/m1"]);
    expect(report.findings.map((f) => f.title)).toEqual(["confirmed before the cap"]);
    expect(report.tasks).toMatchObject([
      { status: "completed", findings: 1, wrapUp: { findings: 1 } },
    ]);
    expect(progress.join("\n")).toContain(
      `${MAX_AGENT_STEPS + 1} step(s), ${MAX_AGENT_STEPS + 2} tool call(s)`,
    );
    expect(progress.join("\n")).toContain("wrap-up turn reported 1 finding(s)");
    expect(report.usage.costUsd).toBeCloseTo(0.02);
  });

  it("still leaves its files partly reviewed: the turn reports, it reads nothing more (ADR-0030)", async () => {
    const { runtime } = scriptedRuntime({ attempt: () => capped(), wrapUp: reports() });
    const report = await reviewWithHooks({ vcs: vcs({}, files(1)), runtime, stages: noChecks });
    expect(report.tasks).toMatchObject([{ ended: "step_cap", wrapUp: { findings: 1 } }]);
    expect(report.coverage).toEqual([
      { path: "src/f0.ts", status: "incomplete", ended: "step_cap" },
    ]);
    expect(report.findings.map((f) => f.title)).toEqual(["confirmed before the cap"]);
  });

  it("gets none when it called task_done", async () => {
    // correctness-1 finishes; correctness-2, at the cap, shows the turn is on.
    const { runtime, wrappedUp } = scriptedRuntime({
      attempt: ({ spec }) => (spec.taskId === "correctness-1" ? finished(spec) : capped()),
      wrapUp: reports(),
    });
    const report = await reviewWithHooks({
      vcs: vcs({}, files(2)),
      runtime,
      bundling: perFile,
      limits: { concurrency: 1 },
      stages: noChecks,
    });
    expect(wrappedUp).toEqual(["correctness-2 fake/m1"]);
    expect(report.tasks.map((t) => t.wrapUp)).toEqual([undefined, { findings: 1 }]);
    expect(report.findings.map((f) => f.title)).toEqual(["found", "confirmed before the cap"]);
  });

  it("gets it on the model the chain failed over to", async () => {
    const { runtime, wrappedUp } = scriptedRuntime(
      {
        attempt: ({ model }) =>
          model === "fake/m1"
            ? { ...capped(), error: { message: "overloaded", retryable: true } }
            : capped(),
        wrapUp: reports(),
      },
      ["fake/m1", "fake/m2"],
    );
    const report = await reviewWithHooks({ vcs: vcs({}, files(1)), runtime, stages: noChecks });
    expect(wrappedUp).toEqual(["correctness-1 fake/m2"]);
    expect(report.tasks[0]?.wrapUp).toEqual({ findings: 1 });
  });
});

describe("the wrap-up turn", () => {
  it("counts toward the spend limit and stops with it", async () => {
    // $0.50 to the cap, then the turn reports $0.40 more: past the review
    // share of $0.80, so the run stops it.
    let stopped: AbortSignal | undefined;
    const { runtime, wrappedUp } = scriptedRuntime({
      attempt: ({ onUsage }) => {
        onUsage(usage(0.5));
        return capped(0.5);
      },
      wrapUp: async ({ signal, onUsage }, before) => {
        onUsage(usage(0.9));
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        stopped = signal;
        return { ...before, usage: usage(0.9), error: { message: "cancelled", retryable: false } };
      },
    });
    const report = await reviewWithHooks({
      vcs: vcs({}, files(1)),
      runtime,
      limits: { maxCostUsd: 1 },
      stages: noChecks,
    });
    expect(wrappedUp).toEqual(["correctness-1 fake/m1"]);
    expect(stopped?.aborted).toBe(true);
    expect(report.tasks.map((t) => [t.status, t.error])).toEqual([
      ["cancelled", "stopped at the spend limit of $1"],
    ]);
    expect(report.usage.costUsd).toBeCloseTo(0.9);
  });

  it("does not start once the spend limit is reached", async () => {
    // correctness-1 shows the turn is on; correctness-2's own steps reach
    // the review share, so it gets none.
    const { runtime, wrappedUp } = scriptedRuntime({
      attempt: ({ spec, onUsage }) => {
        const cost = spec.taskId === "correctness-1" ? 0.1 : 0.7;
        onUsage(usage(cost));
        return capped(cost);
      },
      wrapUp: reports(0.05),
    });
    const report = await reviewWithHooks({
      vcs: vcs({}, files(2)),
      runtime,
      bundling: perFile,
      limits: { concurrency: 1, maxCostUsd: 1 },
      stages: noChecks,
    });
    expect(wrappedUp).toEqual(["correctness-1 fake/m1"]);
    expect(report.tasks.map((t) => t.status)).toEqual(["completed", "cancelled"]);
  });

  it("does not start once the run is cancelled", async () => {
    const controller = new AbortController();
    const { runtime, wrappedUp } = scriptedRuntime({
      attempt: ({ spec }) => {
        if (spec.taskId === "correctness-2") controller.abort();
        return capped();
      },
      wrapUp: reports(),
    });
    const report = await reviewWithHooks({
      vcs: vcs({}, files(2)),
      runtime,
      bundling: perFile,
      limits: { concurrency: 1 },
      stages: noChecks,
      signal: controller.signal,
      abortGraceMs: 100,
    });
    expect(wrappedUp).toEqual(["correctness-1 fake/m1"]);
    expect(report.tasks.map((t) => t.status)).toEqual(["completed", "cancelled"]);
  });
});
