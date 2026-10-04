import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentTaskSpec, CompletionRequest } from "../contracts.js";
import { CompletionError, isOcraError, OcraError } from "../errors.js";
import type { AttemptOutcome } from "./attempt.js";
import { ChainRunner, type ModelAttempts } from "./chain-runner.js";

const outcome = (error?: string): AttemptOutcome => ({
  findings: [],
  steps: 1,
  toolCalls: [],
  text: "answer",
  usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 },
  ...(error ? { error: { message: error, retryable: true } } : {}),
});

const context = {
  readFile: async () => undefined,
  readDiff: () => undefined,
  searchCode: async () => [],
};

const spec = (models?: string[]): AgentTaskSpec => ({
  taskId: "t",
  reviewer: "security",
  modelTier: "standard",
  ...(models ? { models } : {}),
  systemPrompt: "s",
  userPrompt: "u",
  context,
  timeoutMs: 1_000,
});

const request = (models?: string[]): CompletionRequest => ({
  tier: "light",
  agent: "judge",
  ...(models ? { models } : {}),
  system: "s",
  user: "u",
  timeoutMs: 1_000,
});

// Attempts that answer from a table by model and record what they were asked.
function attempts(results: Record<string, string | undefined>, extra: Partial<ModelAttempts> = {}) {
  const log: string[] = [];
  const port: ModelAttempts = {
    task: async (model) => {
      log.push(`task ${model}`);
      return outcome(results[model]);
    },
    complete: async (model) => {
      log.push(`complete ${model}`);
      return outcome(results[model]);
    },
    ...extra,
  };
  return { log, port };
}

async function events(runner: ChainRunner, task: AgentTaskSpec): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  for await (const event of runner.runTask(task, new AbortController().signal)) seen.push(event);
  return seen;
}

const signal = new AbortController().signal;

describe("ChainRunner", () => {
  it("refuses a tier without a model with the same OcraError for tasks and completions", async () => {
    const { log, port } = attempts({});
    const runner = new ChainRunner({ standard: [] }, port);
    const message =
      'No model configured for the "standard" tier; set models.standard in .ocra/config.json or OCRA_MODEL_STANDARD';
    expect(await events(runner, spec())).toEqual([
      { type: "error", taskId: "t", error: message, retryable: false },
    ]);
    const failure = await runner
      .complete({ ...request(), tier: "standard" }, signal)
      .catch((e) => e);
    expect(isOcraError(failure, "CONFIG_INVALID")).toBe(true);
    expect(failure.message).toBe(message);
    expect(log).toEqual([]);
  });

  it("asks the runtime to refuse a chain before starting it or sending anything", async () => {
    const asked: [readonly string[], boolean][] = [];
    let readied = 0;
    const { log, port } = attempts(
      {},
      {
        refuse: (chain, own) => {
          asked.push([chain, own]);
          return new OcraError("CONFIG_INVALID", `cannot reach ${chain[0]}`);
        },
        ready: async () => {
          readied += 1;
        },
      },
    );
    const runner = new ChainRunner({ standard: ["p/a"], light: ["p/l"] }, port);
    expect(await events(runner, spec(["q/own"]))).toEqual([
      { type: "error", taskId: "t", error: "cannot reach q/own", retryable: false },
    ]);
    await expect(runner.complete(request(), signal)).rejects.toThrow("cannot reach p/l");
    expect(asked).toEqual([
      [["q/own"], true],
      [["p/l"], false],
    ]);
    expect(readied).toBe(0);
    expect(log).toEqual([]);
  });

  it("readies the runtime before the first attempt, and fails the call when that fails", async () => {
    const order: string[] = [];
    const { port } = attempts({});
    const runner = new ChainRunner(
      { standard: ["p/a"] },
      {
        ...port,
        ready: async () => {
          order.push("ready");
        },
        task: async (model, ...rest) => {
          order.push(model);
          return port.task(model, ...rest);
        },
      },
    );
    expect((await events(runner, spec())).at(-1)).toEqual({ type: "done", taskId: "t" });
    expect(order).toEqual(["ready", "p/a"]);

    const broken = new ChainRunner(
      { light: ["p/l"] },
      {
        ...port,
        ready: () => Promise.reject(new OcraError("RUNTIME_START_FAILED", "no server")),
      },
    );
    await expect(events(broken, spec(["p/l"]))).rejects.toThrow("no server");
    await expect(broken.complete(request(), signal)).rejects.toThrow("no server");
  });

  it("runs an agent's own chain and names the agent when every model of it fails", async () => {
    const { log, port } = attempts({ "p/x": "down", "p/y": "down" });
    const runner = new ChainRunner({ standard: ["p/a"], light: ["p/l"] }, port);
    expect((await events(runner, spec(["p/x"]))).at(-1)).toEqual({
      type: "error",
      taskId: "t",
      error: "every model of security's own chain failed (p/x: down)",
      retryable: true,
    });
    const failure = await runner.complete(request(["p/y"]), signal).catch((e) => e);
    expect(failure).toBeInstanceOf(CompletionError);
    expect(failure.message).toBe("every model of judge's own chain failed (p/y: down)");
    expect(failure.usage.inputTokens).toBe(1);
    expect(log).toEqual(["task p/x", "complete p/y"]);
  });

  it("keeps each model's health across the calls it serves", async () => {
    const { log, port } = attempts({ "p/a": "down" });
    const runner = new ChainRunner({ standard: ["p/a", "p/b"], light: ["p/a", "p/b"] }, port);
    await events(runner, spec());
    await runner.complete(request(), signal);
    // Two failures open p/a's circuit; the next call goes straight to p/b.
    await events(runner, spec());
    expect(log).toEqual(["task p/a", "task p/b", "complete p/a", "complete p/b", "task p/b"]);
  });
});
