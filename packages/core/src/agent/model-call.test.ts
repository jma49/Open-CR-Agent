import { describe, expect, it } from "vitest";
import type { AgentRuntime, CompletionRequest, Usage } from "../contracts.js";
import { CompletionError } from "../errors.js";
import { oneShot } from "./model-call.js";

const cost = (costUsd: number): Usage => ({
  inputTokens: 1,
  outputTokens: 1,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd,
});

function runtime(complete: AgentRuntime["complete"]): AgentRuntime {
  return {
    name: "fake",
    async *runTask() {},
    ...(complete ? { complete } : {}),
  } as AgentRuntime;
}

const request = {
  tier: "light",
  agent: "helper",
  call: { effort: "low", models: ["m1"] },
  system: "s",
  user: "u",
  timeoutMs: 1_000,
} as const;

describe("oneShot", () => {
  it("is undefined for a runtime without plain completions", () => {
    expect(oneShot(runtime(undefined), () => {})).toBeUndefined();
  });

  it("names the agent, its effort and chain, and reports what an answer cost", async () => {
    const sent: CompletionRequest[] = [];
    const spent: Usage[] = [];
    const ask = oneShot(
      runtime(async (r) => {
        sent.push(r);
        return { text: "answer", usage: cost(0.1) };
      }),
      (u) => spent.push(u),
    );
    expect(await ask?.(request, new AbortController().signal)).toBe("answer");
    expect(sent).toEqual([
      {
        tier: "light",
        agent: "helper",
        effort: "low",
        models: ["m1"],
        system: "s",
        user: "u",
        timeoutMs: 1_000,
      },
    ]);
    expect(spent).toEqual([cost(0.1)]);
  });

  it("reports what a failed call spent, and throws its error", async () => {
    const spent: Usage[] = [];
    const failure = new CompletionError("bad answer", cost(0.2));
    const ask = oneShot(
      runtime(async () => {
        throw failure;
      }),
      (u) => spent.push(u),
    );
    await expect(ask?.(request, new AbortController().signal)).rejects.toBe(failure);
    expect(spent).toEqual([cost(0.2)]);
  });

  it("stops a runtime that ignores the request's timeout through its signal", async () => {
    const ask = oneShot(
      runtime(
        (_, signal) =>
          new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      ),
      () => {},
    );
    await expect(
      ask?.({ ...request, timeoutMs: 10 }, new AbortController().signal),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
