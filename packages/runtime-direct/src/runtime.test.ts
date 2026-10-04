import type { AgentEvent, AgentTaskSpec, ReviewContext } from "@open-cr-agent/core";
import { MAX_AGENT_STEPS, RESUME_MESSAGE } from "@open-cr-agent/core/internal";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeEndpoint,
  type Reply,
  scriptedEndpoint,
} from "../../core/src/runtime/conformance.fakes.js";
import { DirectRuntime } from "./runtime.js";

const KEY = "sk-direct-secret";
const endpoints: FakeEndpoint[] = [];
afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});

async function endpoint(script: readonly (Reply | ((r: never) => Reply))[]) {
  const server = await scriptedEndpoint(script as readonly Reply[]);
  endpoints.push(server);
  return server;
}

function runtime(
  url: string,
  chain: string[] = ["local/m1"],
  env: Record<string, string> = {},
  sampling?: { temperature?: number; seed?: number },
) {
  return new DirectRuntime({
    models: { standard: chain, light: chain },
    tools: [],
    env: { LOCAL_KEY: KEY, ...env },
    ...(sampling ? { sampling } : {}),
    providers: {
      local: {
        baseUrl: url,
        apiKeyEnv: "LOCAL_KEY",
        models: { m1: { input: 3, output: 15, cachedInput: 1 }, m2: { input: 1, output: 2 } },
      },
    },
  });
}

function context(): ReviewContext & { reads: string[]; searches: string[] } {
  const reads: string[] = [];
  const searches: string[] = [];
  return {
    reads,
    searches,
    async readFile(path) {
      reads.push(path);
      return path === "src/a.ts" ? "const a = 1;\nexport { a };\n" : undefined;
    },
    readDiff: (path) => (path === "src/a.ts" ? "@@ -1 +1 @@\n+const a = 1;" : undefined),
    async searchCode(literal) {
      searches.push(literal);
      return [{ path: "src/a.ts", line: 1, text: "const a = 1;" }];
    },
  };
}

function spec(ctx: ReviewContext, timeoutMs = 10_000): AgentTaskSpec {
  return {
    taskId: "t1",
    reviewer: "correctness",
    modelTier: "standard",
    systemPrompt: "system",
    userPrompt: "user",
    context: ctx,
    timeoutMs,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const FINDING = {
  file: "src/a.ts",
  existingCode: "const a = 1;",
  severity: "warning",
  title: "t",
  body: "b",
};

describe("DirectRuntime.runTask", () => {
  it("runs the tool loop against the review context and reports what the model found", async () => {
    const server = await endpoint([
      { toolCalls: [{ name: "read_file", args: { path: "src/a.ts" } }] },
      {
        toolCalls: [
          { name: "read_diff", args: { path: "src/a.ts" } },
          { name: "code_search", args: { literal: "const a" } },
        ],
      },
      { toolCalls: [{ name: "report_finding", args: FINDING }] },
      { content: "Reviewed.", toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    const ctx = context();
    const events = await collect(
      runtime(server.url).runTask(spec(ctx), new AbortController().signal),
    );

    expect(events.map((e) => e.type)).toEqual([
      "progress",
      "usage",
      "usage",
      "usage",
      "usage",
      "usage",
      "progress",
      "finding",
      "done",
    ]);
    expect(events.find((e) => e.type === "finding")).toMatchObject({
      finding: FINDING,
      model: "local/m1",
    });
    // Four steps at 100 in and 10 out each: $3 and $15 per million.
    const spent = events.filter((e) => e.type === "usage");
    const cost = spent.reduce((sum, e) => sum + (e.type === "usage" ? e.costUsd : 0), 0);
    expect(cost).toBeCloseTo(4 * (100 * 3e-6 + 10 * 15e-6), 10);
    expect(events.at(-3)).toMatchObject({
      type: "progress",
      message: expect.stringContaining("4 step(s), 5 tool call(s)"),
    });

    // Everything the model read came through the context.
    expect(ctx.reads).toEqual(["src/a.ts"]);
    expect(ctx.searches).toEqual(["const a"]);
    expect(server.seen).toHaveLength(4);
    expect(server.seen.every((r) => r.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(server.seen[0]?.model).toBe("m1");
    expect(server.seen[0]?.tools?.map((t) => t.function.name)).toEqual([
      "read_file",
      "read_diff",
      "code_search",
      "report_finding",
      "task_done",
    ]);
    expect(server.seen[0]?.tools?.[0]?.function.parameters).toMatchObject({
      type: "object",
      required: ["path"],
    });
    // The tool results went back to the model, as data.
    const toolMessages = server.seen[3]?.messages.filter((m) => m.role === "tool") ?? [];
    expect(toolMessages).toHaveLength(4);
    expect(toolMessages[0]?.content).toContain("1: const a = 1;");
    expect(toolMessages[2]?.content).toContain("src/a.ts:1");
  });

  it("tells the model about a wrong call instead of ending the attempt", async () => {
    const server = await endpoint([
      { toolCalls: [{ name: "report_finding", args: { file: "src/a.ts" } }] },
      { toolCalls: [{ name: "nope", args: {} }] },
      { toolCalls: [{ name: "report_finding", args: FINDING }] },
      { toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    const events = await collect(
      runtime(server.url).runTask(spec(context()), new AbortController().signal),
    );
    expect(events.filter((e) => e.type === "finding")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
    const replies = server.seen.at(-1)?.messages.filter((m) => m.role === "tool") ?? [];
    expect(replies.map((m) => m.content)).toEqual([
      expect.stringMatching(/^Invalid arguments: existingCode: /),
      "Unknown tool: nope",
      "Recorded.",
    ]);
  });

  it("asks an agent that stopped silently to continue, once", async () => {
    const server = await endpoint([
      { content: "" },
      { toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    const events = await collect(
      runtime(server.url).runTask(spec(context()), new AbortController().signal),
    );
    expect(events.at(-1)?.type).toBe("done");
    expect(server.seen[1]?.messages.at(-1)).toEqual({ role: "user", content: RESUME_MESSAGE });
    expect(
      events.find((e) => e.type === "progress" && e.message.includes("step(s)")),
    ).toMatchObject({ message: expect.stringContaining("resumed after stopping early") });
  });

  it("stops at the step cap", async () => {
    const server = await endpoint(
      Array.from({ length: MAX_AGENT_STEPS + 5 }, () => ({
        toolCalls: [{ name: "read_file", args: { path: "src/a.ts" } }],
      })),
    );
    const events = await collect(
      runtime(server.url).runTask(spec(context()), new AbortController().signal),
    );
    expect(server.seen).toHaveLength(MAX_AGENT_STEPS);
    expect(events.at(-1)?.type).toBe("done");
    expect(
      events.find((e) => e.type === "progress" && e.message.includes("step(s)")),
    ).toMatchObject({ message: expect.stringContaining("no task_done") });
  });

  it("moves to the next model on a daily quota and keeps the key out of what it says", async () => {
    const server = await endpoint([
      {
        status: 429,
        body: `{"error":{"message":"Rate limit exceeded: free-models-per-day. key ${KEY}"}}`,
      },
      { toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    const events = await collect(
      runtime(server.url, ["local/m1", "local/m2"]).runTask(
        spec(context()),
        new AbortController().signal,
      ),
    );
    expect(events.at(-1)?.type).toBe("done");
    expect(server.seen.map((r) => r.model)).toEqual(["m1", "m2"]);
    const text = JSON.stringify(events);
    expect(text).toContain("trying the next model");
    expect(text).not.toContain(KEY);
  });

  it("sends a request again after a transient failure, once, to the same model", async () => {
    const server = await endpoint([
      { status: 502, body: "<html>Bad Gateway</html>" },
      { toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    const events = await collect(
      runtime(server.url).runTask(spec(context()), new AbortController().signal),
    );
    expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
    expect(server.seen.map((r) => r.model)).toEqual(["m1", "m1"]);
    expect(JSON.stringify(events)).not.toContain("trying the next model");
  });

  it("reads an error the endpoint reports inside an OK answer", async () => {
    const server = await endpoint([
      {
        status: 200,
        body: '{"error":{"message":"Rate limit exceeded: free-models-per-day","code":429}}',
      },
      { toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    const events = await collect(
      runtime(server.url, ["local/m1", "local/m2"]).runTask(
        spec(context()),
        new AbortController().signal,
      ),
    );
    expect(events.at(-1)?.type).toBe("done");
    // A daily quota is not sent again; the next model answers.
    expect(server.seen.map((r) => r.model)).toEqual(["m1", "m2"]);
    expect(JSON.stringify(events)).toContain("error 429 in an OK answer");
  });

  it("says what an answer that is no completion was, without the key", async () => {
    const malformed = { status: 200, body: `{"choices":[],"debug":"Bearer ${KEY}"}` };
    const server = await endpoint([
      malformed,
      malformed,
      { toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    const events = await collect(
      runtime(server.url, ["local/m1", "local/m2"]).runTask(
        spec(context()),
        new AbortController().signal,
      ),
    );
    expect(events.at(-1)?.type).toBe("done");
    expect(server.seen.map((r) => r.model)).toEqual(["m1", "m1", "m2"]);
    const text = JSON.stringify(events);
    expect(text).toContain('answered without a chat completion: {\\"choices\\":[]');
    expect(text).not.toContain(KEY);
  });

  it("gives up at once on a credential error", async () => {
    const server = await endpoint([{ status: 401, body: '{"error":"bad key"}' }]);
    const events = await collect(
      runtime(server.url, ["local/m1", "local/m2"]).runTask(
        spec(context()),
        new AbortController().signal,
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: false });
    expect(server.seen).toHaveLength(1);
  });

  it("ends when the task is cancelled", async () => {
    const server = await endpoint([{ delayMs: 5_000 }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const events = await collect(runtime(server.url).runTask(spec(context()), controller.signal));
    // Neither finished nor failed: the attempt's summary is the last word.
    expect(events.map((e) => e.type)).toEqual(["progress", "usage", "progress"]);
    expect(events.at(-1)).toMatchObject({ message: expect.stringContaining("1 step(s)") });
  });

  it("runs out of time", async () => {
    const server = await endpoint([{ delayMs: 5_000 }]);
    const events = await collect(
      runtime(server.url).runTask(spec(context(), 100), new AbortController().signal),
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: expect.stringContaining("timed out"),
    });
  });

  it.each([
    ["google/gemini-2.5-flash", /names no provider declared/],
    ["local/m9", /has no price/],
  ])("refuses %s before any request", async (model, message) => {
    const server = await endpoint([]);
    const events = await collect(
      runtime(server.url, [model]).runTask(spec(context()), new AbortController().signal),
    );
    expect(events).toEqual([
      { type: "error", taskId: "t1", retryable: false, error: expect.stringMatching(message) },
    ]);
    expect(server.seen).toHaveLength(0);
  });

  it("refuses to run without the key variable", async () => {
    const server = await endpoint([]);
    const noKey = new DirectRuntime({
      models: { standard: ["local/m1"] },
      tools: [],
      env: {},
      providers: {
        local: {
          baseUrl: server.url,
          apiKeyEnv: "LOCAL_KEY",
          models: { m1: { input: 0, output: 0 } },
        },
      },
    });
    const events = await collect(noKey.runTask(spec(context()), new AbortController().signal));
    expect(events[0]).toMatchObject({ type: "error", error: expect.stringContaining("LOCAL_KEY") });
    expect(server.seen).toHaveLength(0);
  });
});

describe("DirectRuntime.complete", () => {
  it("answers without tools and prices cached tokens at their rate", async () => {
    const server = await endpoint([
      {
        content: "yes",
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 10,
          cached_tokens: 400,
          reasoning_tokens: 3,
        },
      },
    ]);
    const result = await runtime(server.url).complete(
      { tier: "light", system: "s", user: "u", timeoutMs: 5_000 },
      new AbortController().signal,
    );
    expect(result.text).toBe("yes");
    expect(result.usage).toEqual({
      inputTokens: 600,
      outputTokens: 10,
      reasoningTokens: 3,
      cachedTokens: 400,
      // 600 at $3, 400 at $1, 10 at $15 per million.
      costUsd: expect.closeTo(600 * 3e-6 + 400 * 1e-6 + 10 * 15e-6, 10),
    });
    expect(server.seen[0]?.tools).toBeUndefined();
    expect(server.seen[0]?.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]);
  });

  it("reads the key at every request, so a key renewed during a run is used from then on", async () => {
    // The CLI renews the ocra Cloud gateway token in place while a run lasts.
    const server = await endpoint([{ content: "a" }, { content: "b" }]);
    let key = "sk-first";
    const env = Object.defineProperty({}, "LOCAL_KEY", { get: () => key, enumerable: true });
    const live = new DirectRuntime({
      models: { light: ["local/m1"] },
      tools: [],
      env,
      providers: {
        local: {
          baseUrl: server.url,
          apiKeyEnv: "LOCAL_KEY",
          models: { m1: { input: 1, output: 1 } },
        },
      },
    });
    const request = { tier: "light", system: "s", user: "u", timeoutMs: 5_000 } as const;
    await live.complete(request, new AbortController().signal);
    key = "sk-renewed";
    await live.complete(request, new AbortController().signal);
    expect(server.seen.map((r) => r.authorization)).toEqual([
      "Bearer sk-first",
      "Bearer sk-renewed",
    ]);
  });

  it("throws once every model failed twice", async () => {
    const server = await endpoint(Array.from({ length: 4 }, () => ({ status: 500 })));
    await expect(
      runtime(server.url, ["local/m1", "local/m2"]).complete(
        { tier: "light", system: "s", user: "u", timeoutMs: 5_000 },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/every light model failed/);
    expect(server.seen.map((r) => r.model)).toEqual(["m1", "m1", "m2", "m2"]);
  });
});

describe("DirectRuntime sampling", () => {
  it("sends the configured temperature and seed with every request, and says so", async () => {
    const server = await endpoint([
      { toolCalls: [{ name: "read_file", args: { path: "src/a.ts" } }] },
      { content: "Reviewed.", toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    const sampled = runtime(server.url, ["local/m1"], {}, { temperature: 0, seed: 42 });
    await collect(sampled.runTask(spec(context()), new AbortController().signal));
    await sampled.complete(
      { tier: "light", system: "s", user: "u", timeoutMs: 5_000 },
      new AbortController().signal,
    );
    expect(server.seen).toHaveLength(3);
    for (const request of server.seen) expect(request).toMatchObject({ temperature: 0, seed: 42 });
    expect(sampled.sampling).toEqual({ temperature: 0, seed: 42 });
  });

  it("leaves both to the provider when none is configured", async () => {
    const server = await endpoint([{ content: "yes" }]);
    const plain = runtime(server.url);
    await plain.complete(
      { tier: "light", system: "s", user: "u", timeoutMs: 5_000 },
      new AbortController().signal,
    );
    expect(server.seen[0]).not.toHaveProperty("temperature");
    expect(server.seen[0]).not.toHaveProperty("seed");
    expect(plain.sampling).toEqual({});
  });
});
