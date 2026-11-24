import { describe, expect, it } from "vitest";
import { collect, fakeContext } from "../../../../core/src/runtime/conformance.fakes.js";
import { CodexRuntime } from "./runtime.js";

describe("CodexRuntime", () => {
  it("names Codex as the agent behind its reviews", () => {
    const runtime = new CodexRuntime({ models: { standard: [], light: [] }, tools: [], env: {} });
    expect(runtime.agent).toBe("Codex");
  });

  it("refuses a chain with a model Codex does not run, before starting Codex", async () => {
    const runtime = new CodexRuntime({
      binary: "/nonexistent/codex",
      models: { standard: ["codex/default", "openai/gpt-5.5"], light: ["codex/default"] },
      tools: [],
      env: {},
    });
    const events = await collect(
      runtime.runTask(
        {
          taskId: "t1",
          reviewer: "correctness",
          modelTier: "standard",
          systemPrompt: "s",
          userPrompt: "u",
          context: fakeContext(),
          timeoutMs: 1_000,
        },
        new AbortController().signal,
      ),
    );
    expect(events).toEqual([
      {
        type: "error",
        taskId: "t1",
        error:
          'The codex runtime runs only Codex models, written codex/<model> or codex/default; "openai/gpt-5.5" is not one',
        retryable: false,
      },
    ]);
    await runtime.dispose();
  });
});
