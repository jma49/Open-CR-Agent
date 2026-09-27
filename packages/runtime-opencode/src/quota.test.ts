import type { AgentEvent } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { withFailback } from "./failback.js";
import { ModelHealth } from "./models.js";
import { MAX_QUOTA_WAIT_MS, parseQuotaError, QUOTA_RETRIES, sleep } from "./quota.js";
import type { SessionOutcome } from "./session-outcome.js";

// The message Gemini's free tier returned during the 2026-09-26 smoke run.
const GEMINI_QUOTA = `You exceeded your current quota, please check your plan and billing details.
* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.5-flash
Please retry in 53.294873632s.`;

describe("parseQuotaError", () => {
  it("reads the wait Gemini asks for", () => {
    expect(parseQuotaError(GEMINI_QUOTA)).toEqual({ retryAfterMs: 53_295, daily: false });
    expect(parseQuotaError('RESOURCE_EXHAUSTED {"retryDelay": "7s"}')).toEqual({
      retryAfterMs: 7_000,
      daily: false,
    });
  });

  it("recognizes status 429 and daily limits, and ignores other errors", () => {
    expect(parseQuotaError("Too many requests", 429)).toEqual({ daily: false });
    expect(parseQuotaError("Quota exceeded: GenerateRequestsPerDayPerProjectPerModel")).toEqual({
      daily: true,
    });
    expect(
      parseQuotaError("This model is currently experiencing high demand.", 503),
    ).toBeUndefined();
  });
});

describe("ModelHealth quota", () => {
  it("pauses a model for every task, then gives up on it for the run", () => {
    let now = 0;
    const health = new ModelHealth({ now: () => now });
    expect(health.recordQuota("a", { retryAfterMs: 5_000, daily: false })).toBe("wait");
    expect(health.pausedFor("a")).toBe(5_000);
    now = 5_000;
    expect(health.pausedFor("a")).toBe(0);
    for (let i = 1; i < QUOTA_RETRIES; i += 1) {
      expect(health.recordQuota("a", { retryAfterMs: 1, daily: false })).toBe("wait");
    }
    expect(health.recordQuota("a", { retryAfterMs: 1, daily: false })).toBe("out_of_quota");
    expect(health.order(["a", "b"])).toEqual(["b"]);
    expect(health.order(["a"])).toEqual([]);
  });

  it("gives up at once on daily limits, unknown or long waits", () => {
    const health = new ModelHealth();
    expect(health.recordQuota("a", { daily: true, retryAfterMs: 1 })).toBe("out_of_quota");
    expect(health.recordQuota("b", { daily: false })).toBe("out_of_quota");
    expect(health.recordQuota("c", { daily: false, retryAfterMs: MAX_QUOTA_WAIT_MS + 1 })).toBe(
      "out_of_quota",
    );
  });

  it("forgets the waits after a success", () => {
    const health = new ModelHealth();
    health.recordQuota("a", { retryAfterMs: 1, daily: false });
    health.recordSuccess("a");
    expect(health.pausedFor("a")).toBe(0);
  });
});

describe("withFailback on rate limits", () => {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
  };
  const ok: SessionOutcome = { findings: [], toolCalls: [], text: "", usage };
  const limited = (message: string): SessionOutcome => ({
    ...ok,
    error: { message, retryable: true, quota: parseQuotaError(message) as never },
  });

  async function run(
    outcomes: Record<string, SessionOutcome[]>,
    chain: string[],
    health: ModelHealth,
  ) {
    const attempted: string[] = [];
    const events: AgentEvent[] = [];
    for await (const event of withFailback({
      taskId: "t",
      tier: "standard",
      chain,
      health,
      signal: new AbortController().signal,
      attempt: async (model) => {
        attempted.push(model);
        return outcomes[model]?.shift() ?? ok;
      },
    })) {
      events.push(event);
    }
    return { attempted, events };
  }

  it("waits and retries the same model", async () => {
    const health = new ModelHealth();
    const result = await run(
      { a: [limited("quota exceeded. Please retry in 0.02s.")] },
      ["a", "b"],
      health,
    );
    expect(result.attempted).toEqual(["a", "a"]);
    expect(result.events.at(-1)).toMatchObject({ type: "done" });
    expect(
      result.events.some((e) => e.type === "progress" && /rate limited; waiting/.test(e.message)),
    ).toBe(true);
  });

  it("stops sending requests to a model that is out of quota, in every task", async () => {
    const health = new ModelHealth();
    const daily = limited("Quota exceeded for metric: requests per day");
    const first = await run({ a: [daily] }, ["a"], health);
    expect(first.attempted).toEqual(["a"]);
    expect(first.events.at(-1)).toMatchObject({ type: "error" });

    const second = await run({}, ["a"], health);
    expect(second.attempted).toEqual([]);
    expect(second.events.at(-1)).toMatchObject({
      type: "error",
      error: "every standard model is out of quota for this run",
    });

    const fallback = await run({}, ["a", "b"], health);
    expect(fallback.attempted).toEqual(["b"]);
  });
});

describe("sleep", () => {
  it("ends early when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const waiting = sleep(10_000, controller.signal);
    controller.abort();
    await waiting;
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
