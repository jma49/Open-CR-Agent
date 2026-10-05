import type { AgentTaskSpec, AttemptOutcome, Effort } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { effortWarnings } from "../../core/src/agent/settings.js";
import { collect, fakeContext } from "../../core/src/runtime/conformance.fakes.js";
import { EffortRoutes } from "./effort.js";
import { openCodeConfig } from "./opencode-config.js";
import { OpenCodeRuntime, type OpenCodeRuntimeOptions } from "./runtime.js";
import type { PromptInput } from "./session-prompt.js";

const usage = { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 };
const answer: AttemptOutcome = { findings: [], steps: 1, toolCalls: [], text: "ok", usage };
const known = new Map([
  ["anthropic/claude-sonnet-4-5", 64_000],
  ["openai/o3", 100_000],
  ["google/gemini-2.5-flash", 65_536],
]);

// The server is never started: the routes are what setUpEfforts would have
// prepared, and attempts go to a stub that records what each would send.
function stubbed(options: Partial<OpenCodeRuntimeOptions> = {}) {
  const runtime = new OpenCodeRuntime({
    models: { standard: ["anthropic/claude-sonnet-4-5"], top: ["openai/o3"] },
    tools: [],
    env: {},
    ...options,
  });
  const sent: PromptInput[] = [];
  const internals = runtime as unknown as Record<string, unknown>;
  internals.start = async () => ({ efforts: new EffortRoutes([...known.keys()], {}, known) });
  internals.prompt = async (_infra: unknown, input: PromptInput) => {
    sent.push(input);
    return answer;
  };
  return { runtime, sent };
}

const signal = () => new AbortController().signal;
const context = fakeContext();
const task = (reviewer: string, effort?: Effort, models?: string[]): AgentTaskSpec => ({
  taskId: `${reviewer}-1`,
  reviewer,
  modelTier: "standard",
  ...(effort ? { effort } : {}),
  ...(models ? { models } : {}),
  systemPrompt: "s",
  userPrompt: "u",
  context,
  timeoutMs: 1000,
});
const judge = (effort?: Effort) => ({
  tier: "top" as const,
  agent: "judge",
  ...(effort ? { effort } : {}),
  system: "s",
  user: "u",
  timeoutMs: 1000,
});

describe("OpenCodeRuntime effort", () => {
  it("routes two agents on one model at different levels to their own variants", async () => {
    const { runtime, sent } = stubbed();
    await collect(runtime.runTask(task("security", "high"), signal()));
    await collect(runtime.runTask(task("performance", "low"), signal()));
    await collect(runtime.runTask(task("docs"), signal()));
    expect(sent.map((s) => [s.agent, s.model, s.variant])).toEqual([
      ["ocra-reviewer", "anthropic/claude-sonnet-4-5", "ocra-high"],
      ["ocra-reviewer", "anthropic/claude-sonnet-4-5", "ocra-low"],
      ["ocra-reviewer", "anthropic/claude-sonnet-4-5", undefined],
    ]);
    expect(runtime.appliedTo("security")).toEqual({ effort: true });
    expect(runtime.appliedTo("docs")).toBeUndefined();
  });

  it("runs effort calls on the agent without the configured temperature", async () => {
    const { runtime, sent } = stubbed({
      sampling: { temperature: 0, seed: 7 },
      agentModels: { security: ["google/gemini-2.5-flash"] },
    });
    await runtime.complete(judge("high"), signal());
    await runtime.complete(judge(), signal());
    await collect(runtime.runTask(task("security", "none", ["google/gemini-2.5-flash"]), signal()));
    expect(sent.map((s) => [s.agent, s.variant])).toEqual([
      ["ocra-helper-effort", "ocra-high"],
      ["ocra-helper", undefined],
      ["ocra-reviewer", "ocra-none"],
    ]);
    expect(runtime.appliedTo("judge")).toEqual({
      effort: true,
      notApplied: ["temperature", "seed"],
    });
    expect(runtime.appliedTo("security")).toEqual({ effort: true });
  });

  it("drops a level the model does not take, records it, and warns once per agent", async () => {
    const { runtime, sent } = stubbed({ sampling: { temperature: 0 } });
    await runtime.complete(judge("minimal"), signal());
    await runtime.complete(judge("minimal"), signal());
    expect(sent.map((s) => [s.agent, s.variant])).toEqual([
      ["ocra-helper-effort", undefined],
      ["ocra-helper-effort", undefined],
    ]);
    expect(runtime.appliedTo("judge")).toEqual({
      effort: false,
      unsupported: ["openai/o3"],
      notApplied: ["temperature"],
    });
    expect(effortWarnings([{ id: "judge", tier: "top", effort: "minimal" }], runtime)).toEqual([
      'the opencode runtime did not send reasoning effort "minimal" for judge to openai/o3: ocra\'s capability table knows no way to send that level to that model',
    ]);
  });
});

describe("openCodeConfig with a temperature", () => {
  it("adds each agent again without it, for calls that send an effort", () => {
    const config = openCodeConfig(
      { url: "http://127.0.0.1:1/mcp", headers: {} },
      {},
      {},
      {
        temperature: 0,
      },
    );
    const agents: Record<string, unknown> = config.agent;
    expect(agents["ocra-reviewer"]).toMatchObject({ temperature: 0 });
    expect(agents["ocra-reviewer-effort"]).toMatchObject({ mode: "primary" });
    expect(agents["ocra-reviewer-effort"]).not.toHaveProperty("temperature");
    expect(agents["ocra-helper-effort"]).not.toHaveProperty("temperature");
    expect(agents["ocra-wrap-up-effort"]).not.toHaveProperty("temperature");
    const plain = openCodeConfig({ url: "http://127.0.0.1:1/mcp", headers: {} }, {});
    expect(Object.keys(plain.agent)).toEqual(["ocra-reviewer", "ocra-helper", "ocra-wrap-up"]);
  });
});
