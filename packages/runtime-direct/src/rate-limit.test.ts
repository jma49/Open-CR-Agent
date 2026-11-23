import type { AgentEvent, AgentTaskSpec } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeEndpoint,
  type Reply,
  scriptedEndpoint,
} from "../../core/src/runtime/scripted-endpoint.fakes.js";
import { DirectRuntime } from "./runtime.js";

const endpoints: FakeEndpoint[] = [];
afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});

const RATE_LIMITED: Reply = {
  status: 429,
  body: '{"error":{"message":"Rate limit reached. Please retry in 0.02s."}}',
};
const READ: Reply = { toolCalls: [{ name: "read_file", args: { path: "src/a.ts" } }] };
const DONE: Reply = { toolCalls: [{ name: "task_done", args: {} }] };

async function review(script: readonly Reply[], chain = ["local/m1"]) {
  const server = await scriptedEndpoint(script);
  endpoints.push(server);
  const runtime = new DirectRuntime({
    models: { standard: chain },
    tools: [],
    env: {},
    providers: {
      local: {
        baseUrl: server.url,
        models: { m1: { input: 1, output: 1 }, m2: { input: 1, output: 1 } },
      },
    },
  });
  const spec: AgentTaskSpec = {
    taskId: "t1",
    reviewer: "correctness",
    modelTier: "standard",
    systemPrompt: "system",
    userPrompt: "user",
    context: {
      readFile: async () => "const a = 1;\n",
      readDiff: () => undefined,
      searchCode: async () => [],
    },
    timeoutMs: 10_000,
  };
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTask(spec, new AbortController().signal)) {
    events.push(event);
  }
  const messages = events.flatMap((e) => (e.type === "progress" ? [e.message] : []));
  return { server, events, messages };
}

describe("a rate limit in the middle of a review task", () => {
  it("waits and sends the refused step again, with the conversation so far", async () => {
    const { server, events, messages } = await review([READ, RATE_LIMITED, DONE]);

    expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
    expect(server.seen).toHaveLength(3);
    const roles = (index: number) => server.seen[index]?.messages.map((m) => m.role);
    expect(roles(2)).toEqual(["system", "user", "assistant", "tool"]);
    expect(roles(2)).toEqual(roles(1));
    expect(messages).toContainEqual(expect.stringMatching(/^local\/m1 is rate limited; waiting/));
    expect(messages.filter((m) => m.startsWith("reviewing with"))).toHaveLength(1);
    expect(messages).toContainEqual(expect.stringContaining("2 step(s)"));
  });

  it("ends the attempt and moves to the next model when the limit is a daily one", async () => {
    const daily: Reply = {
      status: 429,
      body: '{"error":{"message":"Rate limit exceeded: requests per day"}}',
    };
    const { server, events, messages } = await review(
      [READ, daily, DONE],
      ["local/m1", "local/m2"],
    );

    expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
    expect(server.seen.map((r) => r.model)).toEqual(["m1", "m1", "m2"]);
    expect(messages).toContainEqual(expect.stringContaining("trying the next model"));
  });
});
