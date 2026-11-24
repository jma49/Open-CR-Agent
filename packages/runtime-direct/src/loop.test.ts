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

  it("keeps a task going when a finding sent with task_done was refused", async () => {
    const finding = {
      file: "src/a.ts",
      existingCode: "const a = 1;",
      severity: "warning",
      title: "t",
      body: "b",
    };
    const server = await scriptedEndpoint([
      {
        toolCalls: [
          { name: "report_finding", args: { ...finding, existingCode: "" } },
          { name: "task_done", args: {} },
        ],
      },
      {
        toolCalls: [
          { name: "report_finding", args: finding },
          { name: "task_done", args: {} },
        ],
      },
    ]);
    endpoints.push(server);

    const attempt = await runLoop({
      wire: openaiWire(),
      endpoint: { baseUrl: server.url },
      model: "m1",
      price: { input: 1, output: 1 },
      system: "system",
      user: "user",
      tools: reviewTools,
      context: {
        readFile: async () => undefined,
        readDiff: () => undefined,
        searchCode: async () => [],
      },
      maxSteps: 5,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    expect(attempt.findings).toHaveLength(1);
    expect(attempt.steps).toBe(2);
    expect(attempt.refusedFindings).toBeUndefined();
    const refusal = server.seen.at(-1)?.messages.find((m) => m.role === "tool");
    expect(refusal?.content).toContain("Invalid arguments: existingCode");
  });

  it("names the fields of a refused finding the reviewer never sent again", async () => {
    const server = await scriptedEndpoint([
      {
        toolCalls: [
          { name: "report_finding", args: { file: "src/a.ts", severity: "warning", title: "t" } },
          { name: "task_done", args: {} },
        ],
      },
      { toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    endpoints.push(server);

    const attempt = await runLoop({
      wire: openaiWire(),
      endpoint: { baseUrl: server.url },
      model: "m1",
      price: { input: 1, output: 1 },
      system: "system",
      user: "user",
      tools: reviewTools,
      context: {
        readFile: async () => undefined,
        readDiff: () => undefined,
        searchCode: async () => [],
      },
      maxSteps: 5,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    expect(attempt.findings).toEqual([]);
    expect(attempt.refusedFindings).toEqual(["existingCode, body"]);
  });

  it("takes one sentence of evidence sent as a string", async () => {
    const server = await scriptedEndpoint([
      {
        toolCalls: [
          {
            name: "report_finding",
            args: {
              file: "src/a.ts",
              existingCode: "const a = 1;",
              severity: "warning",
              title: "t",
              body: "b",
              evidence: "code_search found no writer",
            },
          },
        ],
      },
      { toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    endpoints.push(server);

    const attempt = await runLoop({
      wire: openaiWire(),
      endpoint: { baseUrl: server.url },
      model: "m1",
      price: { input: 1, output: 1 },
      system: "system",
      user: "user",
      tools: reviewTools,
      context: {
        readFile: async () => undefined,
        readDiff: () => undefined,
        searchCode: async () => [],
      },
      maxSteps: 5,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    expect(attempt.findings).toMatchObject([{ evidence: ["code_search found no writer"] }]);
    expect(attempt.refusedFindings).toBeUndefined();
  });

  it("keeps a refusal on record when a finding for another file is accepted", async () => {
    const accepted = {
      existingCode: "const a = 1;",
      severity: "warning",
      title: "t",
      body: "b",
    };
    const server = await scriptedEndpoint([
      { toolCalls: [{ name: "report_finding", args: { file: "src/a.ts", title: "t" } }] },
      { toolCalls: [{ name: "report_finding", args: { ...accepted, file: "src/b.ts" } }] },
      { toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    endpoints.push(server);

    const attempt = await runLoop({
      wire: openaiWire(),
      endpoint: { baseUrl: server.url },
      model: "m1",
      price: { input: 1, output: 1 },
      system: "system",
      user: "user",
      tools: reviewTools,
      context: {
        readFile: async () => undefined,
        readDiff: () => undefined,
        searchCode: async () => [],
      },
      maxSteps: 5,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    expect(attempt.findings).toMatchObject([{ file: "src/b.ts" }]);
    expect(attempt.refusedFindings).toEqual(["existingCode, severity, body"]);
  });

  const quiet: ReviewContext = {
    readFile: async () => "const a = 1;\n",
    readDiff: () => undefined,
    searchCode: async () => [],
  };
  const windowed = (url: string, user: string) =>
    runLoop({
      wire: openaiWire(),
      endpoint: { baseUrl: url },
      model: "m1",
      price: { input: 1, output: 1 },
      contextWindow: 8_000,
      system: "system",
      user,
      tools: reviewTools,
      context: quiet,
      maxSteps: 5,
      wrapUp: { message: "report", tools: ["report_finding", "task_done"], steps: 2 },
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

  it("ends a turn whose next request would not fit the context window, and still wraps up", async () => {
    const server = await scriptedEndpoint([
      {
        toolCalls: [{ name: "read_file", args: { path: "src/a.ts" } }],
        usage: { prompt_tokens: 7_000, completion_tokens: 50 },
      },
      { toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    endpoints.push(server);

    const attempt = await windowed(server.url, "user");

    expect(server.seen).toHaveLength(1);
    expect(attempt).toMatchObject({ steps: 1, atContextWindow: true });
    expect(attempt.atStepCap).toBeUndefined();
    expect(attempt.error).toBeUndefined();

    const wrapped = await attempt.wrapUp?.();
    expect(server.seen).toHaveLength(2);
    expect(wrapped?.toolCalls).toEqual(["read_file", "task_done"]);
    expect(wrapped?.atContextWindow).toBeUndefined();
  });

  it("fails an attempt whose prompt alone does not fit, without asking", async () => {
    const server = await scriptedEndpoint([{ content: "never asked" }]);
    endpoints.push(server);

    const attempt = await windowed(server.url, "x".repeat(40_000));

    expect(server.seen).toHaveLength(0);
    expect(attempt.error).toEqual({
      message: "the prompt, about 10002 tokens, does not fit m1's context window of 8000 tokens",
      retryable: true,
    });
  });
});
