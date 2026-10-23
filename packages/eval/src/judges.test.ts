import { errorMessage } from "@open-cr-agent/core";
import { describe, expect, it, vi } from "vitest";
import {
  createJudge,
  GEMINI_OPENAI_URL,
  JUDGE_MAX_TOKENS,
  JUDGE_VERSION,
  judgeConfigFromEnv,
  OpenAICompatibleJudge,
  parseJudgeAnswer,
  UnusableJudgeAnswer,
} from "./judges.js";

const config = { baseUrl: "http://judge/v1/", apiKey: "secret-key", model: "m" };

function completion(content: string | null, extra: Record<string, unknown> = {}): Response {
  return Response.json({
    choices: [{ message: { content }, finish_reason: "stop", ...extra }],
    usage: {
      prompt_tokens: 300,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 100 },
      completion_tokens_details: { reasoning_tokens: 39 },
    },
  });
}

// A fetch answering each request with the next response, and the sleeps the
// judge asked for.
function scripted(...responses: (Response | Error)[]) {
  const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleeps: number[] = [];
  const judge = new OpenAICompatibleJudge(config, fetchImpl as unknown as typeof fetch, {
    sleep: async (ms) => sleeps.push(ms),
  });
  return { judge, fetchImpl, sleeps };
}

function sentBody(fetchImpl: ReturnType<typeof scripted>["fetchImpl"], call = 0) {
  return JSON.parse(String(fetchImpl.mock.calls[call]?.[1].body));
}

describe("judgeConfigFromEnv", () => {
  it("prefers the official judge variables, then a Gemini key", () => {
    expect(
      judgeConfigFromEnv({ JUDGE_API_KEY: "k", JUDGE_BASE_URL: "http://x/v1", JUDGE_MODEL: "m" }),
    ).toEqual({ baseUrl: "http://x/v1", apiKey: "k", model: "m" });
    expect(judgeConfigFromEnv({ GEMINI_API_KEY: "g", JUDGE_MODEL: "m" })).toEqual({
      baseUrl: GEMINI_OPENAI_URL,
      apiKey: "g",
      model: "m",
    });
    expect(judgeConfigFromEnv({})).toBeUndefined();
  });

  it("has no default model: a key without JUDGE_MODEL is refused, saying so", () => {
    expect(() => judgeConfigFromEnv({ JUDGE_API_KEY: "k" })).toThrow(
      /JUDGE_API_KEY is set but JUDGE_MODEL is not.*claude-haiku-5-5/,
    );
    expect(() => judgeConfigFromEnv({ GEMINI_API_KEY: "g" })).toThrow(
      "A Gemini key is set but JUDGE_MODEL is not",
    );
  });
});

describe("parseJudgeAnswer", () => {
  it.each([
    ["Not the same issue.", false],
    ["not similar", false],
    ["No, they are not the same issue", false],
    ["no", false],
    ["Not really; different concerns", false],
    ["Yes", true],
    ["yes.", true],
    ["**Yes**", true],
    ["yes, both flag the null dereference", true],
    ['"YES", same concern', true],
    ["They are not the same.", undefined],
    ["They describe the same issue.", undefined],
    ["The same issue.", undefined],
    ["Same", undefined],
    ["Yesterday", undefined],
    ["", undefined],
  ])("reads %j as %s from its first word only", (answer, expected) => {
    expect(parseJudgeAnswer(answer)).toBe(expected);
  });
});

describe("OpenAICompatibleJudge", () => {
  it("sends no sampling parameters, room to think, and asks for one word", async () => {
    const { judge, fetchImpl } = scripted(completion("Yes"));
    expect(await judge.sameIssue("ref note", "gen note")).toBe(true);
    const body = sentBody(fetchImpl);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
    expect(body).toMatchObject({ model: "m", max_tokens: JUDGE_MAX_TOKENS });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://judge/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
    const prompt: string = body.messages[0].content;
    expect(prompt).toContain("Review Comment 1:\nref note");
    expect(prompt).toContain("Review Comment 2:\ngen note");
    expect(prompt).toMatch(/Answer with one word: "yes" or "no"\.\n\nYour answer:$/);
  });

  it("reads a negation as no match", async () => {
    const { judge } = scripted(completion("Not the same issue."));
    expect(await judge.sameIssue("a", "b")).toBe(false);
  });

  it("counts the tokens every request spent", async () => {
    const { judge } = scripted(completion(""), completion("no"));
    await judge.sameIssue("a", "b");
    expect(judge.usage()).toEqual({
      requests: 2,
      inputTokens: 400,
      cachedTokens: 200,
      outputTokens: 80,
      reasoningTokens: 78,
    });
  });

  it.each([
    ["empty", completion(""), "empty"],
    ["cut off", completion("", { finish_reason: "length" }), 'finish_reason "length"'],
    ["cut off after a word", completion("Yes, because", { finish_reason: "length" }), "cut off"],
    ["refused", completion(null, { message: { content: null, refusal: "I can't" } }), "refused"],
    ["filtered", completion("No", { finish_reason: "content_filter" }), "refused"],
    ["not a yes or no", completion("They are the same."), "not a yes or no"],
  ])("asks once more when the answer is %s, then reports it", async (_case, bad, reason) => {
    const retried = scripted(bad.clone(), completion("yes"));
    expect(await retried.judge.sameIssue("a", "b")).toBe(true);
    expect(retried.fetchImpl).toHaveBeenCalledTimes(2);

    const twice = scripted(bad.clone(), bad);
    const error = await twice.judge.sameIssue("a", "b").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnusableJudgeAnswer);
    expect(errorMessage(error)).toContain(reason);
  });

  it("retries 429, 5xx and network errors with backoff, honoring retry-after", async () => {
    const { judge, fetchImpl, sleeps } = scripted(
      new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
      new Response("overloaded", { status: 529 }),
      new TypeError("fetch failed"),
      completion("no"),
    );
    expect(await judge.sameIssue("a", "b")).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([7000, 4000, 8000]);
  });

  it("fails loudly once retries are spent, without the key", async () => {
    const quota = () => new Response("quota for secret-key", { status: 429 });
    const { judge, fetchImpl } = scripted(quota(), quota(), quota(), quota());
    const error = await judge.sameIssue("a", "b").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(UnusableJudgeAnswer);
    expect(errorMessage(error)).toBe(
      "Judge request failed: HTTP 429 quota for <key> (after 4 attempts)",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("does not wait out a spent quota or retry a refused request", async () => {
    const spent = scripted(
      new Response("daily", { status: 429, headers: { "retry-after": "3600" } }),
    );
    await expect(spent.judge.sameIssue("a", "b")).rejects.toThrow("asked to wait 3600 s");
    expect(spent.sleeps).toEqual([]);

    const refused = scripted(new Response("temperature is not supported", { status: 400 }));
    await expect(refused.judge.sameIssue("a", "b")).rejects.toThrow("HTTP 400");
    expect(refused.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up on a request that does not answer in time", async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    );
    const judge = new OpenAICompatibleJudge(config, hang as unknown as typeof fetch, {
      timeoutMs: 5,
      sleep: async () => {},
    });
    await expect(judge.sameIssue("a", "b")).rejects.toThrow(/no answer: .*timeout/i);
    expect(hang).toHaveBeenCalledTimes(4);
    expect(hang.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("strips control characters from what it quotes of an answer", async () => {
    const odd = () => completion("\u001b[31mmaybe\u202e");
    const { judge } = scripted(odd(), odd());
    const error = await judge.sameIssue("a", "b").catch((e: unknown) => e);
    expect(errorMessage(error)).toContain("maybe");
    expect(errorMessage(error)).not.toContain("\u001b");
    expect(errorMessage(error)).not.toContain("\u202e");
  });
});

describe("createJudge", () => {
  it("names the model, endpoint and judge version, and keeps a cache per model", () => {
    const setup = createJudge(false, {
      JUDGE_API_KEY: "k",
      JUDGE_BASE_URL: "https://api.anthropic.com/v1",
      JUDGE_MODEL: "claude-haiku-5-5",
    });
    expect(setup.id).toBe("claude-haiku-5-5");
    expect(setup.cacheFile).toBe("judge-cache.claude-haiku-5-5.jsonl");
    expect(setup.description).toBe(
      `claude-haiku-5-5 via https://api.anthropic.com/v1, judge v${JUDGE_VERSION}`,
    );
    expect(setup.usage().requests).toBe(0);
  });
});
