import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { SemanticJudge } from "./match.js";

export interface JudgeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const GEMINI_OPENAI_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
export const DEFAULT_JUDGE_MODEL = "gemini-flash-lite-latest";

// Same variable names as the official AACR-Bench evaluation; falls back to a
// Gemini key through Google's OpenAI-compatible endpoint.
export function judgeConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): JudgeConfig | undefined {
  if (env.JUDGE_API_KEY) {
    return {
      baseUrl: env.JUDGE_BASE_URL ?? GEMINI_OPENAI_URL,
      apiKey: env.JUDGE_API_KEY,
      model: env.JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
    };
  }
  const gemini = env.GEMINI_API_KEY ?? env.GOOGLE_GENERATIVE_AI_API_KEY ?? env.GOOGLE_API_KEY;
  return gemini
    ? { baseUrl: GEMINI_OPENAI_URL, apiKey: gemini, model: env.JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL }
    : undefined;
}

export function judgePrompt(reference: string, generated: string): string {
  const task =
    'Determine whether two given review comments express the same concern or suggestion. Ignore differences in wording, tone, or formatting—focus solely on semantic equivalence of the underlying issue. If the core intent and technical substance are identical, answer "yes"; otherwise, answer "no".';
  return [
    "-Role-",
    "You are an expert code reviewer assistant specialized in analyzing and comparing code review comments.",
    "",
    "-Task-",
    task,
    "",
    `Review Comment 1:\n${reference}`,
    "",
    `Review Comment 2:\n${generated}`,
    "",
    "-Task-",
    task,
    "",
    "Your answer:",
  ].join("\n");
}

// Mirrors the reference implementation's lenient answer parsing, except that
// an answer opening with "no" is a no; the original counts "No, they are not
// the same issue" as a match because it contains "same".
export function parseJudgeAnswer(answer: string): boolean {
  const text = answer.trim().toLowerCase();
  if (/^\W*no\b/.test(text)) return false;
  const positive = ["yes", "similar", "same", "identical", "equivalent"].some((w) =>
    text.includes(w),
  );
  if (!positive) return false;
  return !text.includes("yes") || !(text.split("yes")[0] ?? "").includes("no");
}

export class OpenAICompatibleJudge implements SemanticJudge {
  calls = 0;

  constructor(
    private readonly config: JudgeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sameIssue(reference: string, generated: string): Promise<boolean> {
    this.calls += 1;
    const response = await this.fetchImpl(
      `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          messages: [{ role: "user", content: judgePrompt(reference, generated) }],
        }),
      },
    );
    if (!response.ok)
      throw new Error(`Judge request failed: HTTP ${response.status} ${await response.text()}`);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return parseJudgeAnswer(body.choices?.[0]?.message?.content ?? "");
  }
}

// Offline approximation for validating the pipeline only; its numbers are not
// comparable with LLM-judged results.
export class MockJudge implements SemanticJudge {
  async sameIssue(reference: string, generated: string): Promise<boolean> {
    const a = words(reference);
    const b = words(generated);
    if (a.size === 0 || b.size === 0) return false;
    const shared = [...a].filter((w) => b.has(w)).length;
    return shared / (a.size + b.size - shared) >= 0.3;
  }
}

export class CachedJudge implements SemanticJudge {
  private cache = new Map<string, boolean>();

  constructor(
    private readonly inner: SemanticJudge,
    private readonly path: string,
  ) {}

  async load(): Promise<void> {
    try {
      this.cache = new Map(
        Object.entries(JSON.parse(await readFile(this.path, "utf8")) as Record<string, boolean>),
      );
    } catch {
      this.cache = new Map();
    }
  }

  async save(): Promise<void> {
    await writeFile(this.path, `${JSON.stringify(Object.fromEntries(this.cache), null, 2)}\n`);
  }

  async sameIssue(reference: string, generated: string): Promise<boolean> {
    const key = createHash("sha256")
      .update(reference)
      .update("\0")
      .update(generated)
      .digest("hex")
      .slice(0, 32);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const answer = await this.inner.sameIssue(reference, generated);
    this.cache.set(key, answer);
    return answer;
  }
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z_]{3,}/g) ?? []);
}
