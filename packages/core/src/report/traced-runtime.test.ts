import { describe, expect, it } from "vitest";
import type { AgentRuntime, Usage } from "../contracts.js";
import { CompletionError } from "../errors.js";
import type { ReviewEvent } from "./report.js";
import { tracedRuntime } from "./traced-runtime.js";

const usage: Usage = {
  inputTokens: 3,
  outputTokens: 1,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd: 0.002,
};

function ticking() {
  let now = 0;
  return () => {
    now += 40;
    return now;
  };
}

describe("tracedRuntime", () => {
  it("tells each plain completion as a model_called event", async () => {
    const events: ReviewEvent[] = [];
    const runtime: AgentRuntime = {
      name: "fake",
      runTask: async function* () {},
      complete: async () => ({ text: "ok", usage, model: "p/m" }),
    };
    const traced = tracedRuntime(runtime, (e) => events.push(e), ticking());
    const answer = await traced.complete?.(
      { tier: "light", agent: "helper", system: "", user: "", timeoutMs: 1 },
      new AbortController().signal,
    );
    expect(answer?.text).toBe("ok");
    expect(traced.name).toBe("fake");
    expect(events).toEqual([
      { type: "model_called", agent: "helper", model: "p/m", ms: 40, usage },
    ]);
  });

  it("tells a failed call with what it spent, and throws what it threw", async () => {
    const events: ReviewEvent[] = [];
    const runtime: AgentRuntime = {
      name: "fake",
      runTask: async function* () {},
      complete: async () => {
        throw new CompletionError("every light model failed", usage);
      },
    };
    const traced = tracedRuntime(runtime, (e) => events.push(e), ticking());
    await expect(
      traced.complete?.(
        { tier: "light", system: "", user: "", timeoutMs: 1 },
        new AbortController().signal,
      ),
    ).rejects.toThrow("every light model failed");
    expect(events).toEqual([{ type: "model_called", agent: "light", ms: 40, usage, failed: true }]);
  });

  it("keeps the coding agent the runtime names", () => {
    const runtime: AgentRuntime = { name: "codex", agent: "Codex", runTask: async function* () {} };
    expect(tracedRuntime(runtime, () => {}).agent).toBe("Codex");
  });

  it("offers no completion when the runtime has none", () => {
    const traced = tracedRuntime({ name: "fake", runTask: async function* () {} }, () => {});
    expect(traced.complete).toBeUndefined();
  });
});
