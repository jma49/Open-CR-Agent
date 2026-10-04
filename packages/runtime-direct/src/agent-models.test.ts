import type { AgentTaskSpec, CompletionRequest } from "@open-cr-agent/core";
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

const price = { input: 1, output: 1 };

function runtime(url: string, tier: string[] = ["local/m1"]) {
  return new DirectRuntime({
    models: { standard: tier, light: tier, top: tier },
    tools: [],
    env: {},
    providers: { local: { baseUrl: url, models: { m1: price, m2: price, m3: price } } },
  });
}

function task(models?: string[]): AgentTaskSpec {
  return {
    taskId: "t1",
    reviewer: "security",
    modelTier: "standard",
    ...(models ? { models } : {}),
    systemPrompt: "system",
    userPrompt: "user",
    context: fakeContext(),
    timeoutMs: 10_000,
  };
}

function call(models?: string[]): CompletionRequest {
  return {
    tier: "light",
    agent: "helper",
    ...(models ? { models } : {}),
    system: "s",
    user: "u",
    timeoutMs: 5_000,
  };
}

const signal = () => new AbortController().signal;
const down: Reply = { status: 500 };

describe("DirectRuntime with an agent's own chain", () => {
  it("runs a task and a completion on the agent's chain instead of the tier's", async () => {
    const server = await endpoint([{ content: "Reviewed." }, { content: "yes" }]);
    const direct = runtime(server.url, ["local/m1"]);
    await collect(direct.runTask(task(["local/m2"]), signal()));
    await direct.complete(call(["local/m3"]), signal());
    expect(server.seen.map((r) => r.model)).toEqual(["m2", "m3"]);
  });

  it("keeps the tier's chain for a call that carries none", async () => {
    const server = await endpoint([{ content: "Reviewed." }, { content: "yes" }]);
    const direct = runtime(server.url, ["local/m1"]);
    await collect(direct.runTask(task(), signal()));
    await direct.complete(call(), signal());
    expect(server.seen.map((r) => r.model)).toEqual(["m1", "m1"]);
  });

  it("fails over within the agent's chain and names it when every model failed", async () => {
    const server = await endpoint([down, down, { content: "Reviewed." }, down, down, down, down]);
    const direct = runtime(server.url, ["local/m1"]);
    const events = await collect(direct.runTask(task(["local/m2", "local/m3"]), signal()));
    expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
    expect(server.seen.map((r) => r.model)).toEqual(["m2", "m2", "m3"]);

    await expect(direct.complete(call(["local/m2", "local/m3"]), signal())).rejects.toThrow(
      /every model of helper's own chain failed/,
    );
    expect(server.seen.map((r) => r.model).slice(3)).not.toContain("m1");
  });

  it("shares one circuit per model between an agent's chain and a tier's", async () => {
    const server = await endpoint([down, down, { content: "a" }, down, down, { content: "b" }]);
    const direct = runtime(server.url, ["local/m1", "local/m3"]);
    await direct.complete(call(["local/m1", "local/m2"]), signal());
    await direct.complete(call(["local/m1", "local/m2"]), signal());
    // m1 failed twice for the agent: the tier's call goes straight to m3.
    await direct.complete(call(), signal());
    expect(server.seen.map((r) => r.model)).toEqual(["m1", "m1", "m2", "m1", "m1", "m2", "m3"]);
  });

  it("refuses an agent's chain naming an undeclared provider or an unset key, before any request", async () => {
    const server = await endpoint([]);
    const direct = runtime(server.url);
    const events = await collect(direct.runTask(task(["elsewhere/m"]), signal()));
    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        retryable: false,
        error: expect.stringContaining('"elsewhere/m" names no provider'),
      }),
    ]);
    const keyed = new DirectRuntime({
      models: { light: ["local/m1"] },
      tools: [],
      env: {},
      providers: {
        local: { baseUrl: server.url, models: { m1: price } },
        keyed: { baseUrl: server.url, apiKeyEnv: "KEYED_KEY", models: { m: price } },
      },
    });
    await expect(keyed.complete(call(["keyed/m"]), signal())).rejects.toThrow("set KEYED_KEY");
    expect(server.seen).toEqual([]);
  });
});
