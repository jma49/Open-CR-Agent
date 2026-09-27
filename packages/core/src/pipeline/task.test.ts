import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentRuntime, AgentTaskSpec } from "../contracts.js";
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

const callbacks = { onProgress: () => {}, category: "correctness", abortGraceMs: 1_000 };

describe("executeTask", () => {
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
});
