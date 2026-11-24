import { describe, expect, it } from "vitest";
import { codexError, ExecTally } from "./events.js";

const FINDING = { file: "a.ts", existingCode: "x", severity: "warning", title: "T", body: "B" };

function toolCall(tool: string, args: unknown, status = "completed", server = "ocra") {
  return JSON.stringify({
    type: "item.completed",
    item: { id: "i", type: "mcp_tool_call", server, tool, arguments: args, status },
  });
}

const turnCompleted = JSON.stringify({
  type: "turn.completed",
  usage: {
    input_tokens: 300,
    cached_input_tokens: 120,
    cache_write_input_tokens: 0,
    output_tokens: 60,
    reasoning_output_tokens: 15,
  },
});

function tally(lines: readonly string[]): ExecTally {
  const t = new ExecTally();
  for (const line of lines) t.push(line);
  return t;
}

describe("ExecTally", () => {
  it("collects the findings, tool calls, reads and answer of a finished exec", () => {
    const t = tally([
      JSON.stringify({ type: "thread.started", thread_id: "x" }),
      JSON.stringify({ type: "turn.started" }),
      toolCall("read_file", { path: "src/a.ts" }),
      toolCall("code_search", { literal: "foo" }),
      toolCall("report_finding", FINDING),
      toolCall("task_done", {}),
      JSON.stringify({
        type: "item.completed",
        item: { id: "m", type: "agent_message", text: "All files reviewed." },
      }),
      turnCompleted,
    ]);
    expect(t.outcome()).toEqual({
      findings: [FINDING],
      steps: 5,
      toolCalls: ["read_file", "code_search", "report_finding", "task_done"],
      read: ["src/a.ts"],
      searched: ["foo"],
      text: "All files reviewed.",
      usage: {
        inputTokens: 180,
        cachedTokens: 120,
        outputTokens: 60,
        reasoningTokens: 15,
        costUsd: 0,
      },
    });
  });

  it("keeps a finding the tool refused out, while counting the call", () => {
    const outcome = tally([toolCall("report_finding", FINDING, "failed")]).outcome();
    expect(outcome.findings).toEqual([]);
    expect(outcome.toolCalls).toEqual(["report_finding"]);
  });

  it("says when usage changed, so the run can count it as it grows", () => {
    const t = new ExecTally();
    expect(t.push(toolCall("task_done", {}))).toBe(false);
    expect(t.push(turnCompleted)).toBe(true);
    expect(t.push(turnCompleted)).toBe(true);
    expect(t.usage.inputTokens).toBe(360);
  });

  it("names a tool of Codex's own as soon as it starts", () => {
    const t = new ExecTally();
    t.push(
      JSON.stringify({
        type: "item.started",
        item: { id: "c", type: "command_execution", command: "cat /etc/passwd" },
      }),
    );
    expect(t.foreign).toBe("command_execution");
  });

  it("treats another MCP server's tool as Codex's own", () => {
    const t = tally([toolCall("search", {}, "completed", "github")]);
    expect(t.foreign).toBe("mcp_tool_call");
    expect(t.outcome().toolCalls).toEqual([]);
  });

  it("takes the failed turn's message as the attempt's error", () => {
    const outcome = tally([
      JSON.stringify({ type: "error", message: "You’ve hit your usage limit. Try again later." }),
      JSON.stringify({
        type: "turn.failed",
        error: { message: "You’ve hit your usage limit. Try again later." },
      }),
    ]).outcome();
    expect(outcome.error).toEqual({
      message: "You’ve hit your usage limit. Try again later.",
      retryable: true,
      quota: { daily: true },
    });
  });

  it("counts lines it cannot read instead of failing on them", () => {
    const outcome = tally(["not json", JSON.stringify({ no: "type" }), ""]).outcome();
    expect(outcome.unreadMessages).toBe(2);
  });
});

describe("codexError", () => {
  it("stops the chain on a sign-in problem, which every model shares", () => {
    expect(codexError("Not logged in").retryable).toBe(false);
    expect(codexError("unexpected status 401 Unauthorized").retryable).toBe(false);
  });

  it("counts a rate limit as a quota with its stated wait", () => {
    expect(codexError("Rate limit reached. Please retry in 20s.")).toEqual({
      message: "Rate limit reached. Please retry in 20s.",
      retryable: true,
      quota: { daily: false, retryAfterMs: 20_000 },
    });
  });

  it("lets another model try after any other failure", () => {
    expect(codexError("stream disconnected before completion")).toEqual({
      message: "stream disconnected before completion",
      retryable: true,
    });
  });
});
