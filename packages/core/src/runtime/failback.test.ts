import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../contracts.js";
import { type AttemptOutcome, toolSummary } from "./attempt.js";
import { withFailback } from "./failback.js";
import { ModelHealth, parseModel } from "./models.js";

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd: 0.001,
};
const ok = (findings: unknown[] = []): AttemptOutcome => ({
  findings,
  steps: 1,
  toolCalls: [],
  text: "",
  usage,
});
const fail = (message: string, retryable: boolean): AttemptOutcome => ({
  ...ok(),
  error: { message, retryable },
});

async function collect(
  results: Record<string, AttemptOutcome>,
  chain: string[],
  health = new ModelHealth(),
  signal = new AbortController().signal,
) {
  const attempted: string[] = [];
  const events: AgentEvent[] = [];
  for await (const event of withFailback({
    taskId: "t",
    tier: "standard",
    chain,
    health,
    signal,
    attempt: async (model) => {
      attempted.push(model);
      return results[model] as AttemptOutcome;
    },
  })) {
    events.push(event);
  }
  return { attempted, events, types: events.map((e) => e.type) };
}

describe("withFailback", () => {
  it("stops at the first model that succeeds", async () => {
    const run = await collect({ a: ok([{ title: "x" }]) }, ["a", "b"]);
    expect(run.attempted).toEqual(["a"]);
    expect(run.types).toEqual(["progress", "usage", "progress", "finding", "done"]);
    expect(run.events[2]).toMatchObject({
      message: "a: 1 step(s), no tool calls, 1 in / 1 out / 0 reasoning tokens, $0.0010",
    });
  });

  it("moves to the next model on retryable errors and keeps partial findings", async () => {
    const run = await collect(
      { a: { ...fail("503 high demand", true), findings: [{ title: "early" }] }, b: ok() },
      ["a", "b"],
    );
    expect(run.attempted).toEqual(["a", "b"]);
    expect(run.types).toEqual([
      "progress",
      "usage",
      "progress",
      "finding",
      "progress",
      "progress",
      "usage",
      "progress",
      "done",
    ]);
    expect(run.events[3]).toEqual({
      type: "finding",
      taskId: "t",
      finding: { title: "early" },
      model: "a",
    });
  });

  it("stops on errors that another model would not fix", async () => {
    const run = await collect({ a: fail("API key is missing", false) }, ["a", "b"]);
    expect(run.attempted).toEqual(["a"]);
    expect(run.events.at(-1)).toMatchObject({
      type: "error",
      error: "a: API key is missing",
      retryable: false,
    });
  });

  it("reports when every model fails", async () => {
    const run = await collect({ a: fail("busy", true), b: fail("busy too", true) }, ["a", "b"]);
    expect(run.events.at(-1)).toMatchObject({
      type: "error",
      error: "every standard model failed (b: busy too)",
      retryable: true,
    });
  });

  it("skips a model that failed repeatedly earlier in the run", async () => {
    const health = new ModelHealth({ threshold: 2 });
    await collect({ a: fail("busy", true), b: ok() }, ["a", "b"], health);
    await collect({ a: fail("busy", true), b: ok() }, ["a", "b"], health);
    const third = await collect({ a: ok(), b: ok() }, ["a", "b"], health);
    expect(third.attempted).toEqual(["b"]);
  });

  it("does not start when the task is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await collect({ a: ok() }, ["a"], new ModelHealth(), controller.signal);
    expect(run.attempted).toEqual([]);
  });
});

describe("ModelHealth", () => {
  function clock() {
    let time = 0;
    return { now: () => time, advance: (ms: number) => (time += ms) };
  }

  it("opens after repeated failures, probes after the cooldown and closes on success", () => {
    const t = clock();
    const health = new ModelHealth({ threshold: 2, cooldownMs: 1_000, now: t.now });
    health.recordFailure("a");
    expect(health.state("a")).toBe("closed");
    health.recordFailure("a");
    expect(health.state("a")).toBe("open");
    expect(health.order(["a", "b"])).toEqual(["b"]);

    t.advance(1_000);
    expect(health.state("a")).toBe("half-open");
    expect(health.order(["a", "b"])).toEqual(["a", "b"]);
    health.recordSuccess("a");
    expect(health.state("a")).toBe("closed");
  });

  it("reopens a failed probe for twice as long, up to the limit", () => {
    const t = clock();
    const health = new ModelHealth({
      threshold: 1,
      cooldownMs: 1_000,
      maxCooldownMs: 3_000,
      now: t.now,
    });
    health.recordFailure("a");
    t.advance(1_000);
    health.recordFailure("a");
    t.advance(1_999);
    expect(health.state("a")).toBe("open");
    t.advance(1);
    health.recordFailure("a");
    t.advance(2_999);
    expect(health.state("a")).toBe("open");
    t.advance(1);
    expect(health.state("a")).toBe("half-open");
  });

  it("still tries every model, soonest to reopen first, when all are open", () => {
    const t = clock();
    const health = new ModelHealth({ threshold: 1, cooldownMs: 1_000, now: t.now });
    health.recordFailure("b");
    t.advance(10);
    health.recordFailure("a");
    expect(health.order(["a", "b"])).toEqual(["b", "a"]);
  });
});

describe("parseModel", () => {
  it("splits at the first slash so model ids may contain slashes", () => {
    expect(parseModel("google/gemini-flash-lite-latest")).toEqual({
      providerID: "google",
      modelID: "gemini-flash-lite-latest",
    });
    expect(parseModel("openrouter/anthropic/claude")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude",
    });
    expect(() => parseModel("gemini")).toThrow("must be written as provider/model");
  });
});

describe("toolSummary", () => {
  it("counts each tool and says when the review never finished", () => {
    expect(toolSummary(["read_file", "code_search", "read_file", "report_finding"])).toBe(
      "4 tool call(s) (read_file 2, code_search 1, report_finding 1; no task_done)",
    );
    expect(toolSummary(["read_file", "task_done"])).toBe(
      "2 tool call(s) (read_file 1, task_done 1)",
    );
    expect(toolSummary([])).toBe("no tool calls");
  });

  it("reports spend while an attempt runs, adding up to its total", async () => {
    const spent = (costUsd: number) => ({ ...usage, inputTokens: costUsd * 1000, costUsd });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const events: AgentEvent[] = [];
    for await (const event of withFailback({
      taskId: "t",
      tier: "standard",
      chain: ["a"],
      health: new ModelHealth(),
      signal: new AbortController().signal,
      attempt: async (_model, onUsage) => {
        onUsage(spent(0.1));
        await tick();
        onUsage(spent(0.3));
        await tick();
        // A poll that saw less than before changes nothing.
        onUsage(spent(0.2));
        await tick();
        return { ...ok(), usage: spent(0.5) };
      },
    })) {
      events.push(event);
    }
    const costs = events.flatMap((e) => (e.type === "usage" ? [e.costUsd] : []));
    expect(costs.length).toBe(3);
    expect(costs[0]).toBeCloseTo(0.1);
    expect(costs[1]).toBeCloseTo(0.2);
    expect(costs[2]).toBeCloseTo(0.2);
    expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(0.5);
  });
});
