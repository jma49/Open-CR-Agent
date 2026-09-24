import { describe, expect, it } from "vitest";
import { type SessionMessage, summarizeSession } from "./session-outcome.js";

const REPORT = "ocra_report_finding";

function assistant(
  overrides: Partial<SessionMessage["info"]> = {},
  parts: SessionMessage["parts"] = [],
): SessionMessage {
  return { info: { role: "assistant", ...overrides }, parts };
}

describe("summarizeSession", () => {
  it("extracts completed report_finding calls, tool calls and usage", () => {
    const outcome = summarizeSession(
      [
        { info: { role: "user" }, parts: [{ type: "text" }] },
        assistant(
          { cost: 0.001, tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 60 } } },
          [
            {
              type: "tool",
              tool: "ocra_read_file",
              state: { status: "completed", input: { path: "a" } },
            },
          ],
        ),
        assistant({ cost: 0.002, tokens: { input: 200, output: 20 } }, [
          { type: "tool", tool: REPORT, state: { status: "completed", input: { title: "bug" } } },
          { type: "tool", tool: REPORT, state: { status: "error", input: { title: "bad args" } } },
          { type: "tool", tool: "ocra_task_done", state: { status: "completed", input: {} } },
        ]),
      ],
      REPORT,
    );
    expect(outcome.findings).toEqual([{ title: "bug" }]);
    expect(outcome.toolCalls).toEqual(["ocra_read_file", REPORT, REPORT, "ocra_task_done"]);
    expect(outcome.usage).toEqual({
      inputTokens: 300,
      outputTokens: 30,
      reasoningTokens: 5,
      cachedTokens: 60,
      costUsd: 0.003,
    });
    expect(outcome.error).toBeUndefined();
  });

  it("joins the assistant's text answers", () => {
    const outcome = summarizeSession(
      [
        assistant({}, [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "first" },
        ]),
        assistant({}, [{ type: "text", text: "second" }]),
      ],
      REPORT,
    );
    expect(outcome.text).toBe("first\nsecond");
  });

  it("treats an overload followed by a secondary failure as retryable", () => {
    const outcome = summarizeSession(
      [
        assistant({
          error: {
            name: "APIError",
            data: { message: "high demand", statusCode: 503, isRetryable: true },
          },
        }),
        assistant({
          error: {
            name: "APIError",
            data: {
              message: "Requests ending with a model turn are not supported.",
              statusCode: 400,
            },
          },
        }),
      ],
      REPORT,
    );
    expect(outcome.error).toEqual({
      message: "Requests ending with a model turn are not supported.",
      retryable: true,
    });
  });

  it("fails over on model-specific request rejections without an overload", () => {
    const outcome = summarizeSession(
      [
        assistant({
          error: {
            name: "APIError",
            data: {
              message: "Requests ending with a model turn are not supported.",
              statusCode: 400,
            },
          },
        }),
      ],
      REPORT,
    );
    expect(outcome.error?.retryable).toBe(true);
  });

  it("does not fail over on credential errors", () => {
    const forbidden = summarizeSession(
      [
        assistant({
          error: { name: "APIError", data: { message: "Permission denied", statusCode: 403 } },
        }),
      ],
      REPORT,
    );
    expect(forbidden.error?.retryable).toBe(false);
  });

  it("treats authentication errors as not retryable", () => {
    const outcome = summarizeSession(
      [
        assistant({
          error: { name: "ProviderAuthError", data: { message: "API key is missing" } },
        }),
      ],
      REPORT,
    );
    expect(outcome.error).toEqual({ message: "API key is missing", retryable: false });
  });
});
