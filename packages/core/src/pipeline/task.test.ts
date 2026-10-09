import { describe, expect, it } from "vitest";
import { SpendLimitReached } from "../agent/budget.js";
import type { AgentEvent, AgentRuntime, AgentTaskSpec } from "../contracts.js";
import { REVIEW_TOOLS } from "../review/tools.js";
import type { AttemptOutcome } from "../runtime/attempt.js";
import { ChainRunner, type ModelAttempts } from "../runtime/chain-runner.js";
import { executeTask } from "./task.js";

const usage = {
  inputTokens: 100,
  outputTokens: 10,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd: 0.5,
};
const reported = {
  category: "x",
  severity: "critical",
  file: "a.ts",
  existingCode: "a",
  title: "t",
  body: "b",
};

function spec(timeoutMs: number): AgentTaskSpec {
  return {
    taskId: "t1",
    reviewer: "correctness",
    modelTier: "standard",
    systemPrompt: "s",
    userPrompt: "u",
    context: {
      readFile: async () => undefined,
      readDiff: () => undefined,
      searchCode: async () => [],
    },
    timeoutMs,
  };
}

// Like the OpenCode runtime: busy until aborted, then it stops its session
// and reports what the session had already spent and found.
function stoppingRuntime(): AgentRuntime {
  return {
    name: "fake",
    async *runTask(task, signal): AsyncIterable<AgentEvent> {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      yield { type: "usage", taskId: task.taskId, ...usage };
      yield { type: "finding", taskId: task.taskId, finding: reported };
      yield { type: "error", taskId: task.taskId, error: "cancelled", retryable: false };
    },
  };
}

// Through the ChainRunner both shipped runtimes use, which stops yielding
// once the task's signal aborts.
function chainRuntime(task: ModelAttempts["task"]): AgentRuntime {
  const runner = new ChainRunner(
    { standard: ["p/m"] },
    {
      task,
      complete: async () => {
        throw new Error("no completions in these tests");
      },
    },
  );
  return { name: "fake", runTask: (spec, signal) => runner.runTask(spec, signal) };
}

const finished: AttemptOutcome = {
  findings: [reported],
  steps: 2,
  toolCalls: [REVIEW_TOOLS.reportFinding, REVIEW_TOOLS.taskDone],
  text: "",
  usage,
};

const callbacks = { onProgress: () => {}, category: "correctness", abortGraceMs: 1_000 };

// Like the execute stage: the usage report that spends the review share
// stops the run at once.
function stoppingAtLimit(run: AbortController) {
  return { ...callbacks, onUsage: () => run.abort(new SpendLimitReached(1)) };
}

describe("executeTask", () => {
  it("keeps the model a finding event names, and nothing when it names none", async () => {
    const rt: AgentRuntime = {
      name: "fake",
      async *runTask(task): AsyncIterable<AgentEvent> {
        yield { type: "finding", taskId: task.taskId, finding: reported, model: "p/m" };
        yield { type: "finding", taskId: task.taskId, finding: reported };
        yield { type: "done", taskId: task.taskId };
      },
    };
    const result = await executeTask(rt, spec(1_000), new AbortController().signal, callbacks);
    expect(result.findings.map((f) => f.model)).toEqual(["p/m", undefined]);
    expect(result.findings[1]).not.toHaveProperty("model");
  });

  it("keeps the usage and findings a timed-out task delivers while stopping", async () => {
    const result = await executeTask(
      stoppingRuntime(),
      spec(20),
      new AbortController().signal,
      callbacks,
    );
    expect(result.status).toBe("timed_out");
    expect(result.usage.costUsd).toBe(0.5);
    expect(result.findings).toHaveLength(1);
  });

  it("keeps them for a cancelled run too, and stays cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await executeTask(stoppingRuntime(), spec(60_000), controller.signal, callbacks);
    expect(result.status).toBe("cancelled");
    expect(result.usage.inputTokens).toBe(100);
  });

  it("keeps a finished task completed when its last usage report reaches the spend limit", async () => {
    const run = new AbortController();
    const result = await executeTask(
      chainRuntime(async () => finished),
      spec(60_000),
      run.signal,
      stoppingAtLimit(run),
    );
    expect(run.signal.aborted).toBe(true);
    expect(result.status).toBe("completed");
    expect(result).not.toHaveProperty("error");
    expect(result.findings).toHaveLength(1);
    expect(result.usage.costUsd).toBe(0.5);
  });

  it("cancels a task the spend limit stops before it finishes", async () => {
    const run = new AbortController();
    const result = await executeTask(
      chainRuntime(async (_model, _spec, signal, onUsage) => {
        onUsage(usage);
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return {
          ...finished,
          toolCalls: [REVIEW_TOOLS.reportFinding],
          error: { message: "cancelled", retryable: false },
        };
      }),
      spec(60_000),
      run.signal,
      stoppingAtLimit(run),
    );
    expect(result.status).toBe("cancelled");
    expect(result.error).toBe("stopped at the spend limit of $1");
    expect(result.findings).toHaveLength(1);
    expect(result.usage.costUsd).toBe(0.5);
  });

  it("stops waiting after the grace period when the runtime ignores the abort", async () => {
    const hanging: AgentRuntime = {
      name: "fake",
      async *runTask(): AsyncIterable<AgentEvent> {
        await new Promise(() => {});
      },
    };
    const started = Date.now();
    const result = await executeTask(hanging, spec(20), new AbortController().signal, {
      ...callbacks,
      abortGraceMs: 50,
    });
    expect(result.status).toBe("timed_out");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("keeps at most 50 findings per task and bounds their text", async () => {
    const flooding: AgentRuntime = {
      name: "fake",
      async *runTask(task): AsyncIterable<AgentEvent> {
        for (let i = 0; i < 60; i += 1) {
          yield {
            type: "finding",
            taskId: task.taskId,
            finding: { ...reported, title: "x".repeat(1_000) },
          };
        }
        yield { type: "done", taskId: task.taskId };
      },
    };
    const result = await executeTask(
      flooding,
      spec(60_000),
      new AbortController().signal,
      callbacks,
    );
    expect(result.findings).toHaveLength(50);
    expect(result.findings[0]?.reported.title.length).toBe(301);
    expect(result.warnings).toEqual(["more than 50 findings in one task; the rest were dropped"]);
  });
});
