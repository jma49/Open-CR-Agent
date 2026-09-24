import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CachedJudge,
  GEMINI_OPENAI_URL,
  judgeConfigFromEnv,
  OpenAICompatibleJudge,
} from "./judges.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("judgeConfigFromEnv", () => {
  it("prefers the official judge variables, then a Gemini key", () => {
    expect(
      judgeConfigFromEnv({ JUDGE_API_KEY: "k", JUDGE_BASE_URL: "http://x/v1", JUDGE_MODEL: "m" }),
    ).toEqual({
      baseUrl: "http://x/v1",
      apiKey: "k",
      model: "m",
    });
    expect(judgeConfigFromEnv({ GEMINI_API_KEY: "g" })).toEqual({
      baseUrl: GEMINI_OPENAI_URL,
      apiKey: "g",
      model: "gemini-flash-lite-latest",
    });
    expect(judgeConfigFromEnv({})).toBeUndefined();
  });
});

describe("OpenAICompatibleJudge", () => {
  it("sends the judge prompt and parses the answer", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: "Yes, same concern." } }] }),
    );
    const judge = new OpenAICompatibleJudge(
      { baseUrl: "http://judge/v1/", apiKey: "secret", model: "m" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(await judge.sameIssue("ref note", "gen note")).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://judge/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "m", temperature: 0 });
    expect(body.messages[0].content).toContain("Review Comment 1:\nref note");
  });

  it("fails loudly on HTTP errors instead of scoring them as no match", async () => {
    const judge = new OpenAICompatibleJudge(
      { baseUrl: "http://judge", apiKey: "k", model: "m" },
      (async () => new Response("quota", { status: 429 })) as unknown as typeof fetch,
    );
    await expect(judge.sameIssue("a", "b")).rejects.toThrow("Judge request failed: HTTP 429 quota");
  });
});

describe("CachedJudge", () => {
  it("answers repeated questions from the cache and persists it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocra-judge-"));
    dirs.push(dir);
    const inner = { sameIssue: vi.fn(async () => true) };
    const first = new CachedJudge(inner, join(dir, "cache.json"));
    await first.load();
    await first.sameIssue("a", "b");
    await first.sameIssue("a", "b");
    await first.save();
    expect(inner.sameIssue).toHaveBeenCalledTimes(1);

    const second = new CachedJudge(inner, join(dir, "cache.json"));
    await second.load();
    expect(await second.sameIssue("a", "b")).toBe(true);
    expect(inner.sameIssue).toHaveBeenCalledTimes(1);
  });
});
