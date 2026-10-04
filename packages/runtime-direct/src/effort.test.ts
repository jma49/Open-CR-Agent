import type { AgentTaskSpec, CompletionRequest, Effort } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  collect,
  type FakeEndpoint,
  fakeContext,
  type Reply,
  scriptedEndpoint,
} from "../../core/src/runtime/conformance.fakes.js";
import { DirectRuntime } from "./runtime.js";

const endpoints: FakeEndpoint[] = [];
afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});

async function endpoint(script: readonly Reply[]) {
  const server = await scriptedEndpoint(script);
  endpoints.push(server);
  return server;
}

function runtime(
  url: string,
  options: { chain?: string[]; style?: "openrouter"; sampling?: boolean } = {},
) {
  const chain = options.chain ?? ["local/m1"];
  return new DirectRuntime({
    models: { standard: chain, light: chain, top: chain },
    tools: [],
    env: {},
    ...(options.sampling ? { sampling: { temperature: 0, seed: 7 } } : {}),
    providers: {
      local: {
        baseUrl: url,
        ...(options.style ? { effort: options.style } : {}),
        models: { m1: { input: 1, output: 1 }, m2: { input: 1, output: 1 } },
      },
    },
  });
}

function task(effort?: Effort): AgentTaskSpec {
  return {
    taskId: "t1",
    reviewer: "security",
    modelTier: "standard",
    ...(effort ? { effort } : {}),
    systemPrompt: "system",
    userPrompt: "user",
    context: fakeContext(),
    timeoutMs: 10_000,
  };
}

function call(effort?: Effort, agent = "judge"): CompletionRequest {
  return {
    tier: "top",
    agent,
    ...(effort ? { effort } : {}),
    system: "s",
    user: "u",
    timeoutMs: 5_000,
  };
}

const signal = () => new AbortController().signal;
const refusal = (param: string): Reply => ({
  status: 400,
  body: `{"error":{"message":"Unrecognized request argument supplied: ${param}"}}`,
});

describe("DirectRuntime effort", () => {
  it("sends reasoning_effort on every call of the agent, without temperature or seed", async () => {
    const server = await endpoint([
      { toolCalls: [{ name: "read_file", args: { path: "src/a.ts" } }] },
      { content: "Reviewed.", toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    const direct = runtime(server.url, { sampling: true });
    await collect(direct.runTask(task("high"), signal()));
    expect(server.seen).toHaveLength(2);
    for (const request of server.seen) {
      expect(request.reasoning_effort).toBe("high");
      expect(request).not.toHaveProperty("temperature");
      expect(request).not.toHaveProperty("seed");
      expect(request).not.toHaveProperty("reasoning");
    }
    expect(direct.appliedTo("security")).toEqual({
      effort: true,
      notApplied: ["temperature", "seed"],
    });
    expect(direct.appliedTo("judge")).toBeUndefined();
  });

  it("sends none as none, and keeps the sampling settings with it", async () => {
    const server = await endpoint([{ content: "ok" }]);
    const direct = runtime(server.url, { sampling: true });
    await direct.complete(call("none"), signal());
    expect(server.seen[0]).toMatchObject({ reasoning_effort: "none", temperature: 0, seed: 7 });
    expect(direct.appliedTo("judge")).toEqual({ effort: true });
  });

  it("sends nothing about effort when none is asked for", async () => {
    const server = await endpoint([{ content: "ok" }]);
    const direct = runtime(server.url, { sampling: true });
    await direct.complete(call(undefined), signal());
    expect(server.seen[0]).not.toHaveProperty("reasoning_effort");
    expect(server.seen[0]).not.toHaveProperty("reasoning");
    expect(server.seen[0]).toMatchObject({ temperature: 0, seed: 7 });
    expect(direct.appliedTo("judge")).toBeUndefined();
  });

  it("sends reasoning.effort to a provider declared in OpenRouter's style", async () => {
    const server = await endpoint([{ content: "ok" }]);
    await runtime(server.url, { style: "openrouter" }).complete(call("low"), signal());
    expect(server.seen[0]?.reasoning).toEqual({ effort: "low" });
    expect(server.seen[0]).not.toHaveProperty("reasoning_effort");
  });

  it("sends a call again without the effort the endpoint refused, on the same model", async () => {
    const server = await endpoint([
      refusal("reasoning_effort"),
      { content: "ok" },
      { content: "again" },
    ]);
    const direct = runtime(server.url, { chain: ["local/m1", "local/m2"] });
    const answer = await direct.complete(call("medium"), signal());
    expect(answer.text).toBe("ok");
    expect(server.seen.map((r) => [r.model, r.reasoning_effort])).toEqual([
      ["m1", "medium"],
      ["m1", undefined],
    ]);
    expect(direct.appliedTo("judge")).toEqual({ effort: false });

    // The model is still healthy and first in the chain; the refusal is not
    // paid for again.
    await direct.complete(call("medium"), signal());
    expect(server.seen[2]).toMatchObject({ model: "m1" });
    expect(server.seen[2]).not.toHaveProperty("reasoning_effort");
  });

  it("drops the refused effort for the rest of a task's steps", async () => {
    const server = await endpoint([
      refusal("reasoning"),
      { toolCalls: [{ name: "read_file", args: { path: "src/a.ts" } }] },
      { content: "Reviewed.", toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    const direct = runtime(server.url, { style: "openrouter" });
    const events = await collect(direct.runTask(task("high"), signal()));
    expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
    expect(server.seen.map((r) => r.reasoning)).toEqual([{ effort: "high" }, undefined, undefined]);
    expect(direct.appliedTo("security")).toEqual({ effort: false });
  });

  it("treats a 400 that does not name the effort as the model's failure", async () => {
    const server = await endpoint([
      { status: 400, body: '{"error":{"message":"context length exceeded"}}' },
      { content: "ok" },
    ]);
    const direct = runtime(server.url, { chain: ["local/m1", "local/m2"] });
    await direct.complete(call("medium"), signal());
    expect(server.seen.map((r) => [r.model, r.reasoning_effort])).toEqual([
      ["m1", "medium"],
      ["m2", "medium"],
    ]);
    expect(direct.appliedTo("judge")).toEqual({ effort: true });
  });

  it("does not resend a call that asked for no effort when a 400 mentions reasoning", async () => {
    const server = await endpoint([refusal("reasoning_effort"), { content: "ok" }]);
    const direct = runtime(server.url, { chain: ["local/m1", "local/m2"] });
    await direct.complete(call(undefined), signal());
    expect(server.seen.map((r) => r.model)).toEqual(["m1", "m2"]);
  });
});
