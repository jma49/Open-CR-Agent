import type { AgentEvent, AgentTaskSpec, ToolDefinition } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
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

async function run(script: readonly Reply[], pluginTools: readonly ToolDefinition[] = []) {
  const server = await scriptedEndpoint(script);
  endpoints.push(server);
  const edits: unknown[] = [];
  const tool = (name: string): ToolDefinition => ({
    name,
    description: name,
    inputSchema: z.object({ path: z.string().optional() }),
    execute: async (args) => {
      if (name === "edit") edits.push(args);
      return `${name} ran`;
    },
  });
  const spec: AgentTaskSpec = {
    taskId: "mend:1",
    reviewer: "fixer",
    modelTier: "standard",
    systemPrompt: "system",
    userPrompt: "user",
    context: {
      readFile: async () => "const a = 1;",
      readDiff: () => undefined,
      searchCode: async () => [],
    },
    toolset: {
      tools: [tool("edit"), tool("task_done")],
      resume: "Go on with the edits.",
      wrapUp: { message: "Finish or leave it.", tools: ["task_done"] },
    },
    timeoutMs: 10_000,
  };
  const runtime = new DirectRuntime({
    models: { standard: ["local/m1"] },
    tools: pluginTools,
    env: {},
    providers: { local: { baseUrl: server.url, models: { m1: { input: 3, output: 15 } } } },
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.runTask(spec, new AbortController().signal)) {
    events.push(event);
  }
  const offered = server.seen.map((r) => r.tools?.map((t) => t.function.name));
  return { events, edits, offered, seen: server.seen, runtime };
}

describe("DirectRuntime with a task's own toolset", () => {
  it("offers the read tools and the task's, and none that reports a finding or a plugin's", async () => {
    const plugin: ToolDefinition = {
      name: "plugin_tool",
      description: "a plugin's",
      inputSchema: z.object({}),
      execute: async () => "ran",
    };
    const { events, edits, offered, runtime } = await run(
      [
        { toolCalls: [{ name: "read_file", args: { path: "src/a.ts" } }] },
        { toolCalls: [{ name: "edit", args: { path: "src/a.ts" } }] },
        { toolCalls: [{ name: "report_finding", args: {} }] },
        { toolCalls: [{ name: "task_done", args: {} }] },
      ],
      [plugin],
    );
    expect(runtime.toolsets).toBe(true);
    expect(offered[0]).toEqual(["read_file", "read_diff", "code_search", "edit", "task_done"]);
    expect(edits).toEqual([{ path: "src/a.ts" }]);
    expect(events.some((e) => e.type === "finding")).toBe(false);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", taskId: "mend:1" });
    expect(done?.type === "done" && done.ended).toBeUndefined();
  });

  it("tells an agent that stops early to go on in the task's words, then wraps up with its tools", async () => {
    const { events, offered, seen } = await run([
      { content: "" },
      { content: "I am not sure." },
      { toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    expect(seen[1]?.messages.at(-1)).toEqual({ role: "user", content: "Go on with the edits." });
    expect(seen[2]?.messages.at(-1)).toEqual({ role: "user", content: "Finish or leave it." });
    expect(offered[2]).toEqual(["task_done"]);
    // The done tool of the wrap-up turn does not make the task count as finished.
    expect(events.at(-1)).toMatchObject({ type: "done", ended: "stopped_early" });
  });
});
