import { setTimeout } from "node:timers/promises";
import type { Effort, ModelPrice, QuotaError, ToolDefinition, Usage } from "@open-cr-agent/core";
import type { SharedStarts } from "./shared-starts.js";

// What the agent loop needs of a model API, whichever protocol the endpoint
// speaks: each wire keeps the conversation in its own protocol's messages
// and converts at this boundary.

export interface Endpoint {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

// What a request sends besides the conversation, before a wire puts it in
// its protocol's parameters.
export interface CallSettings {
  temperature?: number;
  seed?: number;
  effort?: Effort;
}

export interface ToolRequest {
  id: string;
  name: string;
  input: unknown;
  // The arguments were not JSON, so there is no input to check.
  malformed?: true;
}

export interface CallError {
  message: string;
  retryable: boolean;
  quota?: QuotaError;
  // A failure the next request may not repeat: a dropped connection, a 5xx,
  // an answer that is not a completion.
  transient?: boolean;
  // A 400 that names the effort parameter: the endpoint or model does not
  // take it.
  effortRefused?: boolean;
  // A 400 that names the tools: the endpoint or model takes none.
  toolsRefused?: boolean;
}

// effortDropped: the endpoint refused the effort parameter, and the answer
// is that of the same request sent again without it. toolsDropped: it
// refused the tools, and the answer is that of the request with the tools as
// text (ADR-0070).
export type Answer = (
  | { ok: true; text: string; calls: ToolRequest[]; usage: Usage }
  | { ok: false; error: CallError }
) & { effortDropped?: true; toolsDropped?: true };

export interface Dialogue {
  // shared: where in the text a start that other conversations open with too
  // ends, shortest first; a wire whose endpoint caches marked prefixes marks them.
  say(text: string, shared?: readonly number[]): void;
  // One request with the conversation so far; an answer joins it.
  ask(
    tools: readonly ToolDefinition[],
    settings: CallSettings,
    signal: AbortSignal,
  ): Promise<Answer>;
  // The outputs of the calls the last answer made, in its order.
  answer(outputs: readonly { call: ToolRequest; output: string }[]): void;
}

interface DialogueStart {
  endpoint: Endpoint;
  model: string;
  price: ModelPrice;
  system: string;
  // The dialogue is one request and its answer: nothing reads what the
  // request would store in a provider's prompt cache.
  oneRequest?: boolean;
  // The model calls tools as text from the first request on.
  textTools?: boolean;
  // The run's requests that store a start for each other, on a wire that
  // marks starts.
  starts?: SharedStarts;
}

export type Wire = (start: DialogueStart) => Dialogue;

export function withoutEffort(settings: CallSettings): CallSettings {
  const { effort: _, ...rest } = settings;
  return rest;
}

// A transient failure is sent once more after this pause; a second failure
// goes to the failback, which decides what it means for the model.
const TRANSIENT_RETRY_MS = 1_000;

export async function onceMore<R extends { ok: true } | { ok: false; error: CallError }>(
  send: () => Promise<R>,
  signal: AbortSignal,
): Promise<R> {
  const first = await send();
  if (first.ok || !first.error.transient) return first;
  await setTimeout(TRANSIENT_RETRY_MS, undefined, { signal }).catch(() => undefined);
  if (signal.aborted) return first;
  return send();
}

const AUTH_STATUS = new Set([401, 403]);
// How much of an error body an error message keeps: enough to diagnose, not
// a page of HTML.
const BODY_EXCERPT = 300;

export function retryableStatus(status: number): boolean {
  return !AUTH_STATUS.has(status);
}

export function transientStatus(status: number): boolean {
  return status >= 500 || status === 408;
}

export function excerpt(body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text.length === 0) return "(empty body)";
  return text.length > BODY_EXCERPT ? `${text.slice(0, BODY_EXCERPT)}…` : text;
}

const perToken = (perMillion: number) => perMillion / 1_000_000;

// Tokens as the engine counts them: cached input apart from fresh input, at
// the cached rate when the provider declares one. `writeFactor` is what the
// provider charges above the input rate for the input it stores.
export function pricedUsage(
  tokens: { input: number; cached: number; written?: number; output: number; reasoning: number },
  price: ModelPrice,
  writeFactor = 1,
): Usage {
  const written = tokens.written ?? 0;
  return {
    inputTokens: tokens.input + written,
    outputTokens: tokens.output,
    reasoningTokens: tokens.reasoning,
    cachedTokens: tokens.cached,
    costUsd:
      tokens.input * perToken(price.input) +
      written * perToken(price.input) * writeFactor +
      tokens.cached * perToken(price.cachedInput ?? price.input) +
      tokens.output * perToken(price.output),
  };
}
