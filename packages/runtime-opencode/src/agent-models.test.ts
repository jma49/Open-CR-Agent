import type { AgentTaskSpec, AttemptOutcome } from "@open-cr-agent/core";
import { isOcraError } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { collect, fakeContext } from "../../core/src/runtime/conformance.fakes.js";
import { OpenCodeRuntime, type OpenCodeRuntimeOptions, providersOf } from "./runtime.js";
import { serverEnv } from "./server-env.js";

const usage = { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 };
const answer = (text: string): AttemptOutcome => ({
  findings: [],
  steps: 1,
  toolCalls: ["task_done"],
  text,
  usage,
});
const busy: AttemptOutcome = { ...answer(""), error: { message: "overloaded", retryable: true } };

// The server is never started: attempts go to a stub that answers per model.
function stubbed(
  options: Partial<OpenCodeRuntimeOptions>,
  outcomes: Record<string, AttemptOutcome>,
) {
  const runtime = new OpenCodeRuntime({ models: {}, tools: [], env: {}, ...options });
  const tried: string[] = [];
  const internals = runtime as unknown as Record<string, unknown>;
  internals.start = async () => ({});
  internals.prompt = async (_infra: unknown, input: { model: string }) => {
    tried.push(input.model);
    return outcomes[input.model] ?? answer("ok");
  };
  return { runtime, tried };
}

const signal = () => new AbortController().signal;
const request = (models?: string[]) => ({
  tier: "top" as const,
  agent: "judge",
  ...(models ? { models } : {}),
  system: "s",
  user: "u",
  timeoutMs: 1000,
});
// One runtime serves one review, so its tasks share a context.
const context = fakeContext();
const task = (models?: string[]): AgentTaskSpec => ({
  taskId: "t1",
  reviewer: "security",
  modelTier: "standard",
  ...(models ? { models } : {}),
  systemPrompt: "s",
  userPrompt: "u",
  context,
  timeoutMs: 1000,
});

describe("OpenCodeRuntime with an agent's own chain", () => {
  const options = {
    models: { top: ["google/top"], standard: ["google/std"] },
    agentModels: { judge: ["anthropic/a", "openai/b"], security: ["openai/b"] },
  };

  it("completes on the agent's chain with failback, and keeps the tier's otherwise", async () => {
    const { runtime, tried } = stubbed(options, { "anthropic/a": busy, "openai/b": answer("b") });
    expect((await runtime.complete(request(["anthropic/a", "openai/b"]), signal())).text).toBe("b");
    await runtime.complete(request(), signal());
    expect(tried).toEqual(["anthropic/a", "openai/b", "google/top"]);
  });

  it("runs a task on the agent's chain", async () => {
    const { runtime, tried } = stubbed(options, {});
    const events = await collect(runtime.runTask(task(["openai/b"]), signal()));
    expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
    await collect(runtime.runTask(task(), signal()));
    expect(tried).toEqual(["openai/b", "google/std"]);
  });

  it("shares a model's circuit between the agent's chain and the tier's", async () => {
    const { runtime, tried } = stubbed(
      {
        models: { top: ["anthropic/a", "google/top"] },
        agentModels: { judge: ["anthropic/a", "openai/b"] },
      },
      { "anthropic/a": busy },
    );
    await runtime.complete(request(["anthropic/a", "openai/b"]), signal());
    await runtime.complete(request(["anthropic/a", "openai/b"]), signal());
    await runtime.complete(request(), signal());
    expect(tried).toEqual(["anthropic/a", "openai/b", "anthropic/a", "openai/b", "google/top"]);
  });

  it("refuses a chain naming a provider the runtime was not started with", async () => {
    const { runtime, tried } = stubbed({ models: { top: ["google/top"] } }, {});
    await expect(runtime.complete(request(["anthropic/a"]), signal())).rejects.toThrow(
      '"anthropic/a" is not among the models the runtime was started with',
    );
    const events = await collect(runtime.runTask(task(["anthropic/a"]), signal()));
    expect(events).toEqual([expect.objectContaining({ type: "error", retryable: false })]);
    expect(tried).toEqual([]);
  });
});

describe("credentials for agents' chains", () => {
  it("passes the providers of every agent's chain to OpenCode like a tier's", () => {
    const providers = providersOf({
      models: { standard: ["google/std"] },
      agentModels: { judge: ["anthropic/a"], helper: ["groq/small"] },
    });
    expect(new Set(providers)).toEqual(new Set(["google", "anthropic", "groq"]));
    const env = serverEnv(
      { ANTHROPIC_API_KEY: "sk-ant", GROQ_API_KEY: "gsk", OPENAI_API_KEY: "sk-unused" },
      { config: "/c", data: "/d", state: "/s" },
      providers,
    );
    expect(env).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant", GROQ_API_KEY: "gsk" });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("refuses to start without the key of a provider only an agent's chain names", async () => {
    const runtime = new OpenCodeRuntime({
      models: { top: ["google/top"] },
      agentModels: { judge: ["anthropic/a"] },
      tools: [],
      env: { GEMINI_API_KEY: "g" },
    });
    const error = await runtime.complete(request(), signal()).catch((e: unknown) => e);
    expect(isOcraError(error) && error.code).toBe("CONFIG_CREDENTIALS_MISSING");
    expect(String(error)).toContain("ANTHROPIC_API_KEY");
    await runtime.dispose();
  });
});
