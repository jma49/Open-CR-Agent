import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, AgentRuntime, AgentTaskSpec, ReviewContext } from "../contracts.js";
import { MAX_AGENT_STEPS } from "./attempt.js";

// What every AgentRuntime must do, run against a scripted OpenAI-compatible
// endpoint on this machine, declared as provider "local" with the models
// LOCAL_MODELS and the key in LOCAL_KEY_ENV. A runtime package's
// conformance.test.ts hands in a fixture; the scenarios assert the contract,
// not how a runtime talks to its endpoint.

export const LOCAL_KEY_ENV = "LOCAL_KEY";
export const LOCAL_KEY = "sk-local-secret";
export const LOCAL_MODELS = {
  m1: { input: 3, output: 15 },
  m2: { input: 1, output: 2 },
};

export interface RuntimeFixture {
  // A runtime whose standard and light chains are `chain`, with provider
  // "local" declared at `baseUrl` (LOCAL_MODELS, LOCAL_KEY_ENV) and the key in
  // its environment.
  runtime(baseUrl: string, chain: readonly string[]): AgentRuntime;
  // How long one scenario may take; a runtime that starts a process needs more.
  timeoutMs?: number;
}

export interface SeenRequest {
  authorization: string | undefined;
  model: string;
  stream: boolean;
  messages: { role: string; content?: unknown; tool_call_id?: string; tool_calls?: unknown }[];
  tools: { function: { name: string; parameters: Record<string, unknown> } }[] | undefined;
  temperature?: number;
  seed?: number;
  reasoning_effort?: string;
  reasoning?: { effort: string };
}

export interface Reply {
  content?: string;
  // Tool names as the review tools define them; the endpoint uses the name
  // the request offered that ends with it, so a runtime's prefix is fine.
  toolCalls?: { name: string; args: unknown }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
  };
  // An error instead of a completion.
  status?: number;
  body?: string;
  retryAfter?: number;
  // Hold the answer, so that a test can abort meanwhile.
  delayMs?: number;
}

export interface FakeEndpoint {
  url: string;
  seen: SeenRequest[];
  close(): Promise<void>;
}

// Answers a test scripts, one per request, in order; after the script, text
// and no tools. Streams when asked to, as OpenCode's client does.
export async function scriptedEndpoint(
  script: readonly (Reply | ((request: SeenRequest) => Reply))[],
): Promise<FakeEndpoint> {
  const seen: SeenRequest[] = [];
  const replies = [...script];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end("not found");
        return;
      }
      const parsed = JSON.parse(body) as Omit<SeenRequest, "authorization" | "stream"> & {
        stream?: boolean;
      };
      const request: SeenRequest = {
        ...parsed,
        stream: parsed.stream === true,
        authorization: req.headers.authorization,
      };
      seen.push(request);
      const next = replies.shift() ?? { content: "Done." };
      const reply = typeof next === "function" ? next(request) : next;
      const answer = () => {
        if (reply.status !== undefined) {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (reply.retryAfter !== undefined) headers["retry-after"] = String(reply.retryAfter);
          res
            .writeHead(reply.status, headers)
            .end(reply.body ?? `{"error":{"message":"status ${reply.status}"}}`);
          return;
        }
        const completion = completionOf(request, reply, `call-${seen.length}`);
        if (request.stream) streamed(res, completion);
        else
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(completion));
      };
      if (reply.delayMs) setTimeout(answer, reply.delayMs).unref();
      else answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface Completion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: 0;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    };
    finish_reason: "stop" | "tool_calls";
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details: { cached_tokens: number };
    completion_tokens_details: { reasoning_tokens: number };
  };
}

function completionOf(request: SeenRequest, reply: Reply, callId: string): Completion {
  const offered = request.tools?.map((t) => t.function.name) ?? [];
  const toolCalls = reply.toolCalls?.map((call, i) => ({
    id: `${callId}-${i}`,
    type: "function" as const,
    function: {
      name: offered.find((n) => n === call.name || n.endsWith(`_${call.name}`)) ?? call.name,
      arguments: JSON.stringify(call.args),
    },
  }));
  const usage = reply.usage ?? { prompt_tokens: 100, completion_tokens: 10 };
  return {
    id: callId,
    object: "chat.completion",
    created: 1,
    model: request.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: reply.content ?? null,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.prompt_tokens + usage.completion_tokens,
      prompt_tokens_details: { cached_tokens: usage.cached_tokens ?? 0 },
      completion_tokens_details: { reasoning_tokens: usage.reasoning_tokens ?? 0 },
    },
  };
}

function streamed(res: import("node:http").ServerResponse, completion: Completion): void {
  const choice = completion.choices[0] as Completion["choices"][0];
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", created: 1, model: completion.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(chunk({ role: "assistant", content: choice.message.content ?? "" }, null));
  if (choice.message.tool_calls) {
    res.write(
      chunk(
        { tool_calls: choice.message.tool_calls.map((call, index) => ({ index, ...call })) },
        null,
      ),
    );
  }
  res.write(chunk({}, choice.finish_reason, { usage: completion.usage }));
  res.end("data: [DONE]\n\n");
}

const FILE = "src/a.ts";
const FILE_CONTENT = "const a = 1;\nexport { a };\n";
const FINDING = {
  file: FILE,
  existingCode: "const a = 1;",
  severity: "warning",
  title: "A finding",
  body: "Its body.",
};

export function fakeContext(): ReviewContext & { reads: string[]; searches: string[] } {
  const reads: string[] = [];
  const searches: string[] = [];
  return {
    reads,
    searches,
    async readFile(path) {
      reads.push(path);
      return path === FILE ? FILE_CONTENT : undefined;
    },
    readDiff: (path) => (path === FILE ? "@@ -1 +1 @@\n+const a = 1;" : undefined),
    async searchCode(literal) {
      searches.push(literal);
      return [{ path: FILE, line: 1, text: "const a = 1;" }];
    },
  };
}

function taskSpec(context: ReviewContext, timeoutMs = 60_000): AgentTaskSpec {
  return {
    taskId: "t1",
    reviewer: "correctness",
    modelTier: "standard",
    systemPrompt: "You review code with the tools given.",
    userPrompt: "Review <ocra_review_files>src/a.ts</ocra_review_files>.",
    context,
    timeoutMs,
  };
}

export async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const costOf = (events: readonly AgentEvent[]) =>
  events.reduce((sum, e) => sum + (e.type === "usage" ? e.costUsd : 0), 0);

export function runtimeConformance(name: string, fixture: RuntimeFixture): void {
  const timeout = fixture.timeoutMs ?? 10_000;
  const endpoints: FakeEndpoint[] = [];
  const runtimes: AgentRuntime[] = [];
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.dispose?.();
    for (const endpoint of endpoints.splice(0)) await endpoint.close();
  });
  const start = async (
    script: readonly (Reply | ((request: SeenRequest) => Reply))[],
    chain: readonly string[] = ["local/m1"],
  ) => {
    const endpoint = await scriptedEndpoint(script);
    endpoints.push(endpoint);
    const runtime = fixture.runtime(endpoint.url, chain);
    runtimes.push(runtime);
    return { endpoint, runtime };
  };

  describe(`${name} conforms to AgentRuntime`, () => {
    it(
      "offers the review tools, runs them through the review context, and reports the finding, the usage and the end",
      async () => {
        const { endpoint, runtime } = await start([
          { toolCalls: [{ name: "read_file", args: { path: FILE } }] },
          { toolCalls: [{ name: "report_finding", args: FINDING }] },
          { content: "Reviewed.", toolCalls: [{ name: "task_done", args: {} }] },
        ]);
        const context = fakeContext();
        const events = await collect(
          runtime.runTask(taskSpec(context), new AbortController().signal),
        );

        expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
        expect(events.filter((e) => e.type === "error")).toEqual([]);
        expect(events.filter((e) => e.type === "finding")).toEqual([
          { type: "finding", taskId: "t1", finding: FINDING, model: "local/m1" },
        ]);
        // Every step cost 100 in and 10 out tokens at $3 and $15 per million; a
        // runtime may take one more step than the script to hear task_done out.
        expect(endpoint.seen.length).toBeGreaterThanOrEqual(3);
        expect(costOf(events)).toBeCloseTo(endpoint.seen.length * (100 * 3e-6 + 10 * 15e-6), 10);

        expect(context.reads).toEqual([FILE]);
        const offered = endpoint.seen[0]?.tools?.map((t) => t.function.name) ?? [];
        for (const tool of [
          "read_file",
          "read_diff",
          "code_search",
          "report_finding",
          "task_done",
        ]) {
          expect(offered.some((n) => n === tool || n.endsWith(`_${tool}`))).toBe(true);
        }
        expect(endpoint.seen.every((r) => r.authorization === `Bearer ${LOCAL_KEY}`)).toBe(true);
        expect(endpoint.seen.every((r) => r.model === "m1")).toBe(true);
        // The file's content went back to the model.
        expect(JSON.stringify(endpoint.seen[1]?.messages)).toContain("1: const a = 1;");
      },
      timeout,
    );

    it(
      "says a task that used every step without task_done ended at the step cap",
      async () => {
        // OpenCode tells an agent on its last step to answer in text only; a
        // model that obeys ends there, as one that keeps calling tools would
        // not (it steps past the cap).
        const { endpoint, runtime } = await start(
          Array.from(
            { length: MAX_AGENT_STEPS + 5 },
            () => (request: SeenRequest) =>
              JSON.stringify(request.messages).includes("MAXIMUM STEPS")
                ? { content: "Out of steps." }
                : { toolCalls: [{ name: "read_file", args: { path: FILE } }] },
          ),
        );
        const events = await collect(
          runtime.runTask(taskSpec(fakeContext()), new AbortController().signal),
        );
        expect(events.at(-1)).toEqual({ type: "done", taskId: "t1", ended: "step_cap" });
        expect(endpoint.seen.length).toBeGreaterThanOrEqual(MAX_AGENT_STEPS);
      },
      timeout,
    );

    it(
      "says a task that answered without task_done, steps to spare, stopped early",
      async () => {
        const { runtime } = await start([{ content: "Looks fine to me." }]);
        const events = await collect(
          runtime.runTask(taskSpec(fakeContext()), new AbortController().signal),
        );
        expect(events.at(-1)).toEqual({ type: "done", taskId: "t1", ended: "stopped_early" });
      },
      timeout,
    );

    it(
      "stops on a credential error without trying another model",
      async () => {
        const { endpoint, runtime } = await start(
          [{ status: 401, body: '{"error":{"message":"invalid api key"}}' }],
          ["local/m1", "local/m2"],
        );
        const events = await collect(
          runtime.runTask(taskSpec(fakeContext()), new AbortController().signal),
        );
        expect(events.at(-1)).toMatchObject({ type: "error", retryable: false });
        expect(events.some((e) => e.type === "done")).toBe(false);
        // A client may retry the request; it never asks the next model.
        expect(new Set(endpoint.seen.map((r) => r.model))).toEqual(new Set(["m1"]));
      },
      timeout,
    );

    it(
      "moves to the next model on a daily quota, and the key appears in no event",
      async () => {
        // m1 is out for the day however often a client retries (a short
        // Retry-After keeps those retries quick); m2 answers. OpenCode's
        // client retries m1 a dozen times, so the script outlasts that.
        const { endpoint, runtime } = await start(
          Array.from(
            { length: 30 },
            () => (request: SeenRequest) =>
              request.model === "m1"
                ? {
                    status: 429,
                    retryAfter: 1,
                    body: `{"error":{"message":"Rate limit exceeded: free-models-per-day. ${LOCAL_KEY}"}}`,
                  }
                : { content: "Reviewed.", toolCalls: [{ name: "task_done", args: {} }] },
          ),
          ["local/m1", "local/m2"],
        );
        const events = await collect(
          runtime.runTask(taskSpec(fakeContext()), new AbortController().signal),
        );
        expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
        const models = endpoint.seen.map((r) => r.model);
        expect(models[0]).toBe("m1");
        expect(models.at(-1)).toBe("m2");
        expect(JSON.stringify(events)).not.toContain(LOCAL_KEY);
      },
      timeout,
    );

    it(
      "ends a cancelled task without finishing or failing it",
      async () => {
        const { runtime } = await start([{ delayMs: 20_000 }]);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 500);
        const events = await collect(runtime.runTask(taskSpec(fakeContext()), controller.signal));
        expect(events.some((e) => e.type === "done" || e.type === "error")).toBe(false);
      },
      timeout,
    );

    it(
      "answers a completion without tools, priced",
      async () => {
        const { endpoint, runtime } = await start([
          { content: "yes", usage: { prompt_tokens: 1_000, completion_tokens: 10 } },
        ]);
        if (!runtime.complete) throw new Error("the runtime has no complete()");
        const result = await runtime.complete(
          { tier: "light", system: "Answer in one word.", user: "Ready?", timeoutMs: 30_000 },
          new AbortController().signal,
        );
        expect(result.text).toContain("yes");
        expect(result.usage.costUsd).toBeCloseTo(1_000 * 3e-6 + 10 * 15e-6, 8);
        expect(endpoint.seen[0]?.tools ?? []).toEqual([]);
      },
      timeout,
    );
  });
}
