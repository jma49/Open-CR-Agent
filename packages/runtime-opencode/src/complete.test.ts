import { describe, expect, it } from "vitest";
import { OpenCodeRuntime } from "./runtime.js";
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
  });

  it("requires a model for the tier", async () => {
    const runtime = new OpenCodeRuntime({ models: {}, tools: [], env: {} });
    await expect(runtime.complete(request, new AbortController().signal)).rejects.toThrow(
      'No model configured for the "light" tier',
    );
  });
});
