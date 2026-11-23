import { type ReviewContext, reviewTools } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeEndpoint,
  scriptedEndpoint,
} from "../../core/src/runtime/scripted-endpoint.fakes.js";
import { runLoop } from "./loop.js";
import { openaiWire } from "./openai.js";

const endpoints: FakeEndpoint[] = [];
afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});

describe("runLoop", () => {
  it("runs the tool calls of one step together and answers them in the order given", async () => {
    const server = await scriptedEndpoint([
      {
        toolCalls: [
          { name: "code_search", args: { literal: "first" } },
          { name: "code_search", args: { literal: "second" } },
        ],
      },
      { toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    endpoints.push(server);
    let running = 0;
    let together = 0;
    const context: ReviewContext = {
      readFile: async () => undefined,
      readDiff: () => undefined,
      async searchCode(literal) {
        running += 1;
        together = Math.max(together, running);
        // The first call answers last.
        await new Promise((resolve) => setTimeout(resolve, literal === "first" ? 20 : 1));
        running -= 1;
        return [{ path: "src/a.ts", line: 1, text: literal }];
      },
    };

    const attempt = await runLoop({
      wire: openaiWire(),
      endpoint: { baseUrl: server.url },
      model: "m1",
      price: { input: 1, output: 1 },
      system: "system",
      user: "user",
      tools: reviewTools,
      context,
      maxSteps: 5,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    expect(together).toBe(2);
    expect(attempt.toolCalls).toEqual(["code_search", "code_search", "task_done"]);
    const answers = server.seen.at(-1)?.messages.filter((m) => m.role === "tool") ?? [];
    expect(answers.map((m) => m.content)).toEqual(["src/a.ts:1: first", "src/a.ts:1: second"]);
  });
});
