import { describe, expect, it } from "vitest";
import { REFUSALS } from "./fake-ocra.fakes.js";
import { logLine, lostTo, providerLimit } from "./provider-limits.js";

describe("providerLimit", () => {
  it.each([
    ["Anthropic's credit balance", REFUSALS.credit],
    [
      "a 402 from Anthropic, as a declared endpoint words it",
      'HTTP 402: {"type":"error","error":{"type":"billing_error","message":"Payment required"}}',
    ],
    ["Anthropic's spend limit", REFUSALS["spend-limit"]],
    [
      "an organization's spend limit",
      "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
    ],
    [
      "OpenAI's spent credit",
      "You exceeded your current quota, please check your plan and billing details.",
    ],
    ["OpenRouter's credits", "Insufficient credits. This request requires more credits."],
    ["OpenRouter's daily limit", "Rate limit exceeded: free-models-per-day-stealth."],
    [
      "Gemini's daily limit",
      "You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier. Please retry in 41.2s.",
    ],
  ])("calls %s a spent quota", (_, message) => {
    expect(providerLimit(message)).toBe("quota");
  });

  it.each([
    ["Vertex AI's shared quota", REFUSALS.vertex],
    ["Anthropic's per-minute limit", REFUSALS["per-minute"]],
    ["Anthropic's overload", REFUSALS.overloaded],
    ["the runtime giving up on a model", "every light model is out of quota for this run"],
    ["a bare 429", "HTTP 429: Too Many Requests"],
    [
      "Gemini's per-minute limit",
      "You exceeded your current quota, please check your plan and billing details. quotaId: GenerateContentInputTokensPerModelPerMinute-FreeTier. Please retry in 33.7s.",
    ],
  ])("calls %s a rate limit", (_, message) => {
    expect(providerLimit(message)).toBe("rate_limit");
  });

  it.each([
    "stopped at the spend limit of $2",
    "spend limit of $2 reached",
    "timed out after 600000ms",
    "no activity for 300s",
    'No API key for provider "vertex": set VERTEX_ACCESS_TOKEN',
  ])("leaves %j to the review", (message) => {
    expect(providerLimit(message)).toBeUndefined();
  });
});

describe("lostTo", () => {
  it("names a spent quota before a rate limit", () => {
    const tasks = [
      { taskId: "a-1", status: "failed" as const, error: REFUSALS.vertex },
      { taskId: "b-1", status: "failed" as const, error: REFUSALS.credit },
    ];
    expect(lostTo({ tasks })).toEqual({ limit: "quota", error: REFUSALS.credit });
  });

  it("reads ocra's error output only when the review ran no task", () => {
    expect(lostTo({ tasks: [], error: `[ocra] ${REFUSALS.credit}` })?.limit).toBe("quota");
    const ran = [{ taskId: "a-1", status: "completed" as const }];
    expect(lostTo({ tasks: ran, error: REFUSALS.credit })).toBeUndefined();
  });
});

describe("logLine", () => {
  it("prints a provider's error on one line, without terminal controls", () => {
    expect(logLine("quota\u001b]8;;https://x\u0007 spent\n  retry‮ later")).toBe(
      "quota]8;;https://x spent retry later",
    );
    expect(logLine("x".repeat(400))).toHaveLength(301);
  });
});
