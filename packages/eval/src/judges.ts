import { setTimeout } from "node:timers/promises";
import { errorMessage, proxiedFetch, withoutSecrets } from "@open-cr-agent/core";
import { isUnsafeCodePoint } from "@open-cr-agent/core/internal";
import { z } from "zod";
import type { SemanticJudge } from "./match.js";

export interface JudgeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const GEMINI_OPENAI_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

// Bump when the prompt or the answer parsing changes: cached answers are keyed
// by it, and the run's judge description names it, so compare and trend warn.
export const JUDGE_VERSION = 2;

// Room for a model that thinks before its one word; the cap bounds what a
// runaway answer costs.
export const JUDGE_MAX_TOKENS = 4000;
const TIMEOUT_MS = 120_000;
const ATTEMPTS = 4;
const FIRST_BACKOFF_MS = 2_000;
// A longer stated wait is a spent quota, not a busy moment.
const MAX_WAIT_MS = 60_000;

// Same variable names as the official AACR-Bench evaluation; falls back to a
// Gemini key through Google's OpenAI-compatible endpoint. No default model:
// the judge decides every match, and a provider's alias can vanish.
export function judgeConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): JudgeConfig | undefined {
  const apiKey =
    env.JUDGE_API_KEY ||
    (env.GEMINI_API_KEY ?? env.GOOGLE_GENERATIVE_AI_API_KEY ?? env.GOOGLE_API_KEY);
  if (!apiKey) return undefined;
  if (!env.JUDGE_MODEL)
    throw new Error(
      `${env.JUDGE_API_KEY ? "JUDGE_API_KEY" : "A Gemini key"} is set but JUDGE_MODEL is not: ocra-eval has no default judge model. Name one, for example JUDGE_MODEL=claude-haiku-5-5 with JUDGE_BASE_URL=https://api.anthropic.com/v1 and an Anthropic key in JUDGE_API_KEY`,
    );
  return {
    baseUrl: (env.JUDGE_API_KEY ? env.JUDGE_BASE_URL : undefined) ?? GEMINI_OPENAI_URL,
    apiKey,
    model: env.JUDGE_MODEL,
  };
}

// The official AACR-Bench judge prompt, plus a last line asking for one word.
// The comments are not put in ocra sections: data() neutralizes only those
// tags, and wrapping would no longer be the benchmark's prompt.
function judgePrompt(reference: string, generated: string): string {
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
    'Answer with one word: "yes" or "no".',
    "",
    "Your answer:",
  ].join("\n");
}

// Stricter than the official parser, which finds "yes", "same" or "similar"
// anywhere and so reads "Not the same issue" as a match: only the first word
// counts. Anything else is no answer (undefined), not a "no".
export function parseJudgeAnswer(answer: string): boolean | undefined {
  const first = /^[^\p{L}]*(\p{L}+)/u.exec(answer)?.[1]?.toLowerCase();
  if (first === "yes") return true;
  if (first === "no" || first === "not") return false;
  return undefined;
}

// The judge gave no verdict, asked twice: empty, cut off, refused or not a
// yes or no. Scoring counts it apart instead of reading it as a "no".
export class UnusableJudgeAnswer extends Error {}

export interface JudgeUsage {
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

const NO_USAGE: JudgeUsage = {
  requests: 0,
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export function usageSince(before: JudgeUsage, after: JudgeUsage): JudgeUsage {
  return {
    requests: after.requests - before.requests,
    inputTokens: after.inputTokens - before.inputTokens,
    cachedTokens: after.cachedTokens - before.cachedTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    reasoningTokens: after.reasoningTokens - before.reasoningTokens,
  };
}

const choiceSchema = z.object({
  message: z.object({ content: z.string().nullish(), refusal: z.string().nullish() }),
  finish_reason: z.string().nullish(),
});
const completionSchema = z.object({
  // At least one: the first is the answer.
  choices: z.tuple([choiceSchema], choiceSchema),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
      completion_tokens_details: z.object({ reasoning_tokens: z.number().nullish() }).nullish(),
    })
    .nullish(),
});
type Choice = z.output<typeof choiceSchema>;

type Answer = { same: boolean } | { unusable: string };

function readAnswer(choice: Choice): Answer {
  const content = choice.message.content ?? "";
  const finish = choice.finish_reason;
  if (choice.message.refusal) return { unusable: `refused: ${excerpt(choice.message.refusal)}` };
  if (finish === "length")
    return { unusable: `cut off at ${JUDGE_MAX_TOKENS} tokens (finish_reason "length")` };
  if (finish === "content_filter") return { unusable: 'refused (finish_reason "content_filter")' };
  const same = parseJudgeAnswer(content);
  if (same !== undefined) return { same };
  return content.trim()
    ? { unusable: `not a yes or no: "${excerpt(content)}"` }
    : { unusable: `empty (finish_reason ${JSON.stringify(finish ?? null)})` };
}

type Posted =
  | { ok: true; choice: Choice }
  | { ok: false; message: string; retryable: boolean; retryAfterMs?: number };

export interface JudgeClientOptions {
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
}

// One chat completion per question. Not runtime-direct's client: that one
// drops finish_reason at its boundary, and eval reaches no runtime package.
export class OpenAICompatibleJudge implements SemanticJudge {
  private readonly spent: JudgeUsage = { ...NO_USAGE };

  private readonly config: JudgeConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<unknown>;

  constructor(
    config: JudgeConfig,
    fetchImpl: typeof fetch = fetch,
    options: JudgeClientOptions = {},
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.sleep = options.sleep ?? setTimeout;
  }

  usage(): JudgeUsage {
    return { ...this.spent };
  }

  async sameIssue(reference: string, generated: string): Promise<boolean> {
    // No sampling parameters: Anthropic refuses temperature, top_p and top_k.
    const body = JSON.stringify({
      model: this.config.model,
      max_tokens: JUDGE_MAX_TOKENS,
      messages: [{ role: "user", content: judgePrompt(reference, generated) }],
    });
    const first = readAnswer(await this.complete(body));
    if ("same" in first) return first.same;
    const second = readAnswer(await this.complete(body));
    if ("same" in second) return second.same;
    throw new UnusableJudgeAnswer(`No usable answer after asking twice: ${second.unusable}`);
  }

  private async complete(body: string): Promise<Choice> {
    for (let attempt = 1; ; attempt += 1) {
      const posted = await this.post(body);
      if (posted.ok) return posted.choice;
      const wait = posted.retryAfterMs ?? FIRST_BACKOFF_MS * 2 ** (attempt - 1);
      if (!posted.retryable || attempt === ATTEMPTS || wait > MAX_WAIT_MS) {
        const after = attempt > 1 ? ` (after ${attempt} attempts)` : "";
        const asked = wait > MAX_WAIT_MS ? `; asked to wait ${Math.ceil(wait / 1000)} s` : "";
        throw new Error(`Judge request failed: ${posted.message}${after}${asked}`);
      }
      await this.sleep(wait);
    }
  }

  private async post(body: string): Promise<Posted> {
    this.spent.requests += 1;
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(
        `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      text = await response.text();
    } catch (error) {
      return { ok: false, retryable: true, message: `no answer: ${errorMessage(error)}` };
    }
    // An endpoint may echo the request's headers in an error page.
    const shown = excerpt(withoutSecrets(text, [this.config.apiKey]));
    if (!response.ok) {
      const retryAfterMs = retryAfter(response.headers.get("retry-after"));
      return {
        ok: false,
        message: `HTTP ${response.status} ${shown}`,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, retryable: true, message: `answered without JSON: ${shown}` };
    }
    const parsed = completionSchema.safeParse(json);
    if (!parsed.success)
      return { ok: false, retryable: true, message: `answered without a completion: ${shown}` };
    const usage = parsed.data.usage;
    const prompt = usage?.prompt_tokens ?? 0;
    const cached = Math.min(prompt, usage?.prompt_tokens_details?.cached_tokens ?? 0);
    this.spent.inputTokens += prompt - cached;
    this.spent.cachedTokens += cached;
    this.spent.outputTokens += usage?.completion_tokens ?? 0;
    this.spent.reasoningTokens += usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    return { ok: true, choice: parsed.data.choices[0] };
  }
}

// Seconds or an HTTP date.
function retryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

// Model and endpoint text reaches the terminal in error messages.
function excerpt(text: string): string {
  let out = "";
  for (const char of text.replace(/\s+/g, " ").trim().slice(0, 300))
    out += isUnsafeCodePoint(char.codePointAt(0) ?? 0) ? "�" : char;
  return out;
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

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z_]{3,}/g) ?? []);
}

export interface JudgeSetup {
  judge: SemanticJudge;
  // The model, or "mock": part of every cached answer's key.
  id: string;
  cacheFile: string;
  description: string;
  usage: () => JudgeUsage;
}

export function createJudge(mock: boolean, env: NodeJS.ProcessEnv): JudgeSetup {
  if (mock) {
    return {
      judge: new MockJudge(),
      id: "mock",
      cacheFile: "judge-cache.mock.jsonl",
      description: "mock (word overlap, not comparable)",
      usage: () => ({ ...NO_USAGE }),
    };
  }
  const config = judgeConfigFromEnv(env);
  if (!config)
    throw new Error(
      "No judge configured: set JUDGE_API_KEY (or GEMINI_API_KEY) and JUDGE_MODEL, or pass --mock-judge",
    );
  const judge = new OpenAICompatibleJudge(config, proxiedFetch(env));
  return {
    judge,
    id: config.model,
    cacheFile: `judge-cache.${config.model.replace(/[^\w.-]/g, "_")}.jsonl`,
    description: `${config.model} via ${config.baseUrl}, judge v${JUDGE_VERSION}`,
    usage: () => judge.usage(),
  };
}
