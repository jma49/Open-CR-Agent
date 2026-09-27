import { describe, expect, it } from "vitest";
import type { SessionMessage } from "./session-outcome.js";
import { promptSession } from "./session-prompt.js";

const REPORT_TOOL = "ocra_report_finding";
const input = { title: "t", agent: "a", model: "google/m", system: "s", user: "u", tools: {} };

// What OpenCode holds for a session that reported one finding before it was
// cut off.
const spent: SessionMessage[] = [
  {
    info: { role: "assistant", cost: 0.25, tokens: { input: 1000, output: 50 } },
    parts: [
      {
        type: "tool",
        tool: REPORT_TOOL,
        state: { status: "completed", input: { title: "x" } },
      },
    ],
  },
];

function session(prompt: (signal: AbortSignal) => Promise<never>) {
  const aborted: string[] = [];
  return {
    aborted,
    api: {
      create: async () => ({ data: { id: "s1" } }),
      prompt: async (_: unknown, options: { signal: AbortSignal }) => prompt(options.signal),
      messages: async () => ({ data: spent }),
      abort: async ({ sessionID }: { sessionID: string }) => {
        aborted.push(sessionID);
        return { data: true };
      },
    } as never,
  };
}

describe("promptSession", () => {
  it("stops the session and keeps its spend and findings when the transport fails", async () => {
    const fake = session(async () => {
      throw new TypeError("terminated");
    });
    const outcome = await promptSession(fake.api, input, REPORT_TOOL, new AbortController().signal);
    expect(fake.aborted).toEqual(["s1"]);
    expect(outcome.usage.costUsd).toBe(0.25);
    expect(outcome.findings).toHaveLength(1);
    // Retryable: the next model in the chain gets its turn.
    expect(outcome.error).toEqual({ message: "terminated", retryable: true });
  });

  it("does the same when the task is cancelled, without retrying", async () => {
    const controller = new AbortController();
    const fake = session(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    setTimeout(() => controller.abort(), 10);
    const outcome = await promptSession(fake.api, input, REPORT_TOOL, controller.signal);
    expect(fake.aborted).toContain("s1");
    expect(outcome.usage.inputTokens).toBe(1000);
    expect(outcome.error).toEqual({ message: "cancelled", retryable: false });
  });
});
