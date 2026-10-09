import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../contracts.js";
import type { AttemptOutcome } from "./attempt.js";
import { completeWithFailback, withFailback } from "./failback.js";
import { ModelHealth } from "./models.js";
import { MAX_QUOTA_WAIT_MS, parseQuotaError, QUOTA_RETRIES, sleep } from "./quota.js";

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
    expect(parseQuotaError("Rate limit exceeded: free-models-per-day", 429)).toEqual({
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
      now += 1;
    }
    expect(health.recordQuota("a", { retryAfterMs: 1, daily: false })).toBe("out_of_quota");
    expect(health.order(["a", "b"])).toEqual(["b"]);
    expect(health.order(["a"])).toEqual([]);
  });

  it("gives up at once on daily limits and long waits", () => {
    const health = new ModelHealth();
    expect(health.recordQuota("a", { daily: true, retryAfterMs: 1 })).toBe("out_of_quota");
    expect(health.recordQuota("c", { daily: false, retryAfterMs: MAX_QUOTA_WAIT_MS + 1 })).toBe(
      "out_of_quota",
    );
  });

  // Vertex AI's shared quota answers a busy moment with a bare 429.
  it("backs off on a limit without a stated wait, then gives up", () => {
    let now = 0;
    const health = new ModelHealth({ now: () => now });
    const waits: number[] = [];
    for (let i = 0; i < QUOTA_RETRIES; i += 1) {
      expect(health.recordQuota("a", { daily: false })).toBe("wait");
      waits.push(health.pausedFor("a"));
      now += health.pausedFor("a");
    }
    expect(waits).toEqual([15_000, 30_000, 60_000]);
    expect(health.recordQuota("a", { daily: false })).toBe("out_of_quota");
  });

  // Tasks running at once send their requests together and are refused
  // together; the default concurrency is four.
  it("counts the limits of one burst as one wait", () => {
    let now = 0;
    const health = new ModelHealth({ now: () => now });
    const waits: number[] = [];
    for (let burst = 0; burst < QUOTA_RETRIES; burst += 1) {
      for (let request = 0; request < 4; request += 1) {
        expect(health.recordQuota("a", { daily: false })).toBe("wait");
      }
      waits.push(health.pausedFor("a"));
      now += health.pausedFor("a");
    }
    expect(waits).toEqual([15_000, 30_000, 60_000]);
    expect(health.recordQuota("a", { daily: false })).toBe("out_of_quota");
  });

  it("keeps the pause a burst began when more limits without a wait arrive", () => {
    let now = 0;
    const health = new ModelHealth({ now: () => now });
    health.recordQuota("a", { daily: false });
    now = 10_000;
    expect(health.recordQuota("a", { daily: false })).toBe("wait");
    expect(health.pausedFor("a")).toBe(5_000);
  });

  it("lets a limit during a pause lengthen it to the wait it states", () => {
    const health = new ModelHealth({ now: () => 0 });
    for (const retryAfterMs of [5_000, 20_000, 10_000, 1_000]) {
      expect(health.recordQuota("a", { retryAfterMs, daily: false })).toBe("wait");
    }
    expect(health.pausedFor("a")).toBe(20_000);
    expect(health.recordQuota("a", { daily: true })).toBe("out_of_quota");
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
  const ok: AttemptOutcome = { findings: [], steps: 0, toolCalls: [], text: "", usage };
  const limited = (message: string): AttemptOutcome => ({
    ...ok,
    error: { message, retryable: true, quota: parseQuotaError(message) as never },
  });

  async function run(
    outcomes: Record<string, AttemptOutcome[]>,
    chain: string[],
    health: ModelHealth,
    onEvent: (event: AgentEvent) => void = () => {},
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
      onEvent(event);
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

  // Another task's request runs into the daily limit while this one waits.
  it("moves on from a paused model that another task found out of quota", async () => {
    const health = new ModelHealth();
    health.recordQuota("a", { retryAfterMs: 20, daily: false });
    const result = await run({}, ["a", "b"], health, (event) => {
      if (event.type === "progress" && /rate limited/.test(event.message)) {
        health.recordQuota("a", { daily: true });
      }
    });
    expect(result.attempted).toEqual(["b"]);
    expect(result.events.at(-1)).toMatchObject({ type: "done" });
  });

  // Each task must wait for the pause as the other's limit left it, or the
  // two take turns lengthening it and the model is never given up.
  it("gives up on a model that stays limited for tasks refused a little apart", async () => {
    const health = new ModelHealth();
    let refusals = 0;
    const task = async (firstLatencyMs: number) => {
      const attempted: string[] = [];
      const events: AgentEvent[] = [];
      for await (const event of withFailback({
        taskId: "t",
        tier: "standard",
        chain: ["a", "b"],
        health,
        signal: new AbortController().signal,
        attempt: async (model) => {
          attempted.push(model);
          if (model === "b") return ok;
          const latency = attempted.length === 1 ? firstLatencyMs : 5;
          await new Promise((resolve) => setTimeout(resolve, latency));
          refusals += 1;
          // Bounded, so a version that never gives up on "a" ends.
          return refusals > 20 ? ok : limited("quota exceeded. Please retry in 0.1s.");
        },
      })) {
        events.push(event);
      }
      return attempted;
    };
    const [first, second] = await Promise.all([task(5), task(45)]);
    expect(first.at(-1)).toBe("b");
    expect(second.at(-1)).toBe("b");
    expect(refusals).toBeLessThanOrEqual(2 * (QUOTA_RETRIES + 1));
  });

  it("answers a call from the next model when the paused one runs out of quota", async () => {
    const health = new ModelHealth();
    health.recordQuota("a", { retryAfterMs: 20, daily: false });
    const attempted: string[] = [];
    const answer = completeWithFailback({
      tier: "light",
      chain: ["a", "b"],
      health,
      signal: new AbortController().signal,
      attempt: async (model) => {
        attempted.push(model);
        return { ...ok, text: model };
      },
    });
    health.recordQuota("a", { daily: true });
    expect((await answer).text).toBe("b");
    expect(attempted).toEqual(["b"]);
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
