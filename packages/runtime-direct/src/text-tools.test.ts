import type { AgentEvent, AgentTaskSpec, CustomProvider } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeEndpoint,
  type Reply,
  type SeenRequest,
  scriptedEndpoint,
} from "../../core/src/runtime/scripted-endpoint.fakes.js";
import { DirectRuntime } from "./runtime.js";

// An endpoint whose models take no `tools` parameter (ADR-0070).

const endpoints: FakeEndpoint[] = [];
afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});

async function endpoint(script: (request: SeenRequest) => Reply) {
  const server = await scriptedEndpoint(script);
  endpoints.push(server);
  return server;
}

function runtime(url: string, toolCalls?: CustomProvider["toolCalls"]) {
  return new DirectRuntime({
    models: { standard: ["corp/m1"] },
    tools: [],
    env: {},
    providers: {
      corp: {
        baseUrl: url,
        models: { m1: { input: 0, output: 0 } },
        ...(toolCalls && { toolCalls }),
      },
    },
  });
}

const task: AgentTaskSpec = {
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

async function run(direct: DirectRuntime): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of direct.runTask(task, new AbortController().signal)) events.push(event);
  return events;
}

const FINDING = {
  file: "src/a.ts",
  existingCode: "const a = 1;",
  severity: "warning",
  title: "t",
  body: "b",
};
const block = (name: string, args: unknown) =>
  `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;
const STEPS = [
  `Reading.\n${block("read_file", { path: "src/a.ts" })}`,
  block("report_finding", FINDING),
  block("task_done", {}),
];
// A model that writes its calls as text, one step per request it was sent.
const asText = (request: SeenRequest): Reply => ({
  content: STEPS[request.messages.filter((m) => m.role === "assistant").length] ?? "Done.",
});
// vLLM without a tool call parser.
const REFUSAL = {
  status: 400,
  body: '{"object":"error","message":"\\"auto\\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set","code":400}',
};

describe("a provider declared with tool calls as text", () => {
  it("is sent the tools in the system prompt, and its blocks run as calls", async () => {
    const server = await endpoint(asText);
    const events = await run(runtime(server.url, "text"));

    expect(events.filter((e) => e.type === "finding")).toEqual([
      { type: "finding", taskId: "t1", finding: FINDING, model: "corp/m1" },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
    expect(server.seen).toHaveLength(3);
    for (const request of server.seen) {
      expect(request.tools).toBeUndefined();
      expect(request.messages.some((m) => m.role === "tool")).toBe(false);
      expect(request.messages[0]?.content).toMatch(/^system\n\n## Calling tools\n/);
      expect(request.messages[0]?.content).toContain("- read_file: ");
    }
    expect(server.seen[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: '<ocra_tool_result tool="read_file">\n1: const a = 1;\n2: \n</ocra_tool_result>',
    });
  });

  it("tells the model about a block that is no call instead of ending the attempt", async () => {
    const steps = ["<tool_call>\nread_file src/a.ts\n</tool_call>", block("task_done", {})];
    const server = await endpoint((request) => ({
      content: steps[request.messages.filter((m) => m.role === "assistant").length] ?? "Done.",
    }));
    const events = await run(runtime(server.url, "text"));

    expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
    expect(server.seen[1]?.messages.at(-1)?.content).toContain("Unknown tool: unknown");
  });
});

describe("an endpoint that refuses the tools", () => {
  it("is asked again with the tools as text, and the review runs", async () => {
    const server = await endpoint((request) => (request.tools ? REFUSAL : asText(request)));
    const events = await run(runtime(server.url));

    expect(events.filter((e) => e.type === "finding")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
    expect(server.seen.map((r) => r.tools !== undefined)).toEqual([true, false, false, false]);
  });

  it("is refused once in a run: the model's later tasks start with the tools as text", async () => {
    const server = await endpoint((request) => (request.tools ? REFUSAL : asText(request)));
    const direct = runtime(server.url);
    await run(direct);
    const before = server.seen.length;
    await run(direct);

    expect(server.seen.slice(before).some((r) => r.tools !== undefined)).toBe(false);
  });

  it("is not asked as text once the conversation holds a call's result", async () => {
    const server = await endpoint((request) =>
      request.messages.some((m) => m.role === "tool")
        ? { status: 400, body: '{"error":{"message":"invalid tool message"}}' }
        : { toolCalls: [{ name: "read_file", args: { path: "src/a.ts" } }] },
    );
    const events = await run(runtime(server.url));

    expect(JSON.stringify(events)).toContain("invalid tool message");
    expect(server.seen.every((r) => r.tools !== undefined)).toBe(true);
  });
});
