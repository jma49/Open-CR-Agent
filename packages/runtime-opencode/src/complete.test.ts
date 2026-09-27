import { usageSpent } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { parseQuotaError } from "./quota.js";
import { HELPER_AGENT_STEPS, OpenCodeRuntime, openCodeConfig } from "./runtime.js";
import type { SessionOutcome } from "./session-outcome.js";

const usage = {
  inputTokens: 10,
  outputTokens: 2,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd: 0.001,
};
const request = { tier: "light" as const, system: "s", user: "u", timeoutMs: 1000 };

function runtimeWith(outcomes: Record<string, SessionOutcome>, models: string[]) {
  const runtime = new OpenCodeRuntime({ models: { light: models }, tools: [], env: {} });
  const calls: { model: string; agent: string; tools: Record<string, boolean> }[] = [];
  const internals = runtime as unknown as Record<string, unknown>;
  internals.start = async () => ({});
  internals.prompt = async (
    _infra: unknown,
    input: { model: string; agent: string; tools: Record<string, boolean> },
  ) => {
    calls.push(input);
    return outcomes[input.model];
  };
  return { runtime, calls };
}

describe("OpenCodeRuntime.complete", () => {
  it("answers with a tool-less helper agent and fails over on retryable errors", async () => {
    const { runtime, calls } = runtimeWith(
      {
        a: {
          findings: [],
          toolCalls: [],
          text: "",
          usage,
          error: { message: "high demand", retryable: true },
        },
        b: { findings: [], toolCalls: [], text: '[{"label":"x","files":[0]}]', usage },
      },
      ["a", "b"],
    );
    const result = await runtime.complete(request, new AbortController().signal);
    expect(result.text).toBe('[{"label":"x","files":[0]}]');
    expect(result.usage.inputTokens).toBe(20);
    expect(calls.map((c) => c.model)).toEqual(["a", "b"]);
    expect(calls[0]?.agent).toBe("ocra-helper");
    expect(calls[0]?.tools).toMatchObject({
      bash: false,
      ocra_read_file: false,
      ocra_report_finding: false,
    });
  });

  it("stops on credential errors and reports when every model fails", async () => {
    const auth = runtimeWith(
      {
        a: {
          findings: [],
          toolCalls: [],
          text: "",
          usage,
          error: { message: "API key is missing", retryable: false },
        },
      },
      ["a", "b"],
    );
    await expect(auth.runtime.complete(request, new AbortController().signal)).rejects.toThrow(
      "a: API key is missing",
    );
    expect(auth.calls).toHaveLength(1);

    const busy = {
      findings: [],
      toolCalls: [],
      text: "",
      usage,
      error: { message: "busy", retryable: true },
    };
    const all = runtimeWith({ a: busy, b: busy }, ["a", "b"]);
    await expect(all.runtime.complete(request, new AbortController().signal)).rejects.toThrow(
      "every light model failed (b: busy)",
    );
    // What the failed attempts spent travels with the error.
    const failure = await all.runtime
      .complete(request, new AbortController().signal)
      .catch((e) => e);
    expect(usageSpent(failure)?.inputTokens).toBe(20);
  });

  it("requires a model for the tier", async () => {
    const runtime = new OpenCodeRuntime({ models: {}, tools: [], env: {} });
    await expect(runtime.complete(request, new AbortController().signal)).rejects.toThrow(
      'No model configured for the "light" tier',
    );
  });
});

describe("OpenCodeRuntime credentials", () => {
  it("fails fast with the variable to set when a provider has no key", async () => {
    const runtime = new OpenCodeRuntime({
      models: { light: ["google/gemini-flash-lite-latest"] },
      tools: [],
      env: {},
      binary: "/nonexistent/opencode",
    });
    await expect(runtime.complete(request, new AbortController().signal)).rejects.toThrow(
      'No API key for provider "google": set GEMINI_API_KEY',
    );
    await runtime.dispose();
  });
});

describe("OpenCodeRuntime.complete on rate limits", () => {
  it("waits and retries, then gives up on a model out of quota", async () => {
    const limited = (message: string): SessionOutcome => ({
      findings: [],
      toolCalls: [],
      text: "",
      usage,
      error: { message, retryable: true, quota: parseQuotaError(message) as never },
    });
    const queue = [limited("quota exceeded, retry in 0.01s"), limited("Quota exceeded: per day")];
    const runtime = new OpenCodeRuntime({ models: { light: ["a"] }, tools: [], env: {} });
    const calls: string[] = [];
    const internals = runtime as unknown as Record<string, unknown>;
    internals.start = async () => ({});
    internals.prompt = async (_infra: unknown, input: { model: string }) => {
      calls.push(input.model);
      return queue.shift();
    };
    await expect(runtime.complete(request, new AbortController().signal)).rejects.toThrow(
      "every light model failed",
    );
    expect(calls).toEqual(["a", "a"]);
    await expect(runtime.complete(request, new AbortController().signal)).rejects.toThrow(
      "every light model is out of quota for this run",
    );
    expect(calls).toEqual(["a", "a"]);
  });
});

describe("openCodeConfig", () => {
  it("never gives an agent a single step, which Gemini rejects (#66)", () => {
    const config = openCodeConfig({ url: "http://127.0.0.1:1/mcp", headers: {} }, {});
    for (const agent of Object.values(config.agent)) expect(agent.steps).toBeGreaterThan(1);
    expect(config.agent["ocra-helper"].steps).toBe(HELPER_AGENT_STEPS);
  });
});
