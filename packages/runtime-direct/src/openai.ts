import {
  errorMessage,
  type ModelPrice,
  parseQuotaError,
  type QuotaError,
  sleep,
  type ToolDefinition,
  type Usage,
  withoutSecrets,
} from "@open-cr-agent/core";
import { z } from "zod";

// The subset of the OpenAI chat completions protocol the loop needs: one
// choice, its text and tool calls, and the token counts. Anything else an
// endpoint adds is dropped at this boundary.
const toolCallSchema = z.object({
  id: z.string(),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z.array(toolCallSchema).optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).optional(),
      completion_tokens_details: z.object({ reasoning_tokens: z.number().optional() }).optional(),
    })
    .optional(),
});
// OpenRouter answers some upstream failures with status 200 and this body.
const errorBodySchema = z.object({
  error: z.object({ message: z.string(), code: z.number().optional() }),
});

export type ToolCall = z.infer<typeof toolCallSchema>;

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Endpoint {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export interface ChatRequest {
  model: string;
  messages: readonly ChatMessage[];
  tools?: readonly ToolSpec[];
}

export interface ChatError {
  message: string;
  retryable: boolean;
  quota?: QuotaError;
  // A failure the next request may not repeat: a dropped connection, a 5xx,
  // an answer that is not a completion.
  transient?: boolean;
}

export type ChatResponse =
  | { ok: true; content: string; toolCalls: ToolCall[]; usage: Usage }
  | { ok: false; error: ChatError };

const AUTH_STATUS = new Set([401, 403]);
// How much of an error body an error message keeps: enough to diagnose, not
// a page of HTML.
const BODY_EXCERPT = 300;
// A transient failure is sent once more after this pause; a second failure
// goes to the failback, which decides what it means for the model.
export const TRANSIENT_RETRY_MS = 1_000;

export function toolSpec(tool: ToolDefinition): ToolSpec {
  const { $schema: _, ...parameters } = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters },
  };
}

// One request to the endpoint, sent a second time when the first failed in
// a way a moment may cure. Only the key named for this provider goes out,
// and only to its base URL.
export async function chat(
  endpoint: Endpoint,
  request: ChatRequest,
  price: ModelPrice,
  signal: AbortSignal,
): Promise<ChatResponse> {
  const first = await send(endpoint, request, price, signal);
  if (first.ok || !first.error.transient) return first;
  await sleep(TRANSIENT_RETRY_MS, signal);
  if (signal.aborted) return first;
  return send(endpoint, request, price, signal);
}

async function send(
  endpoint: Endpoint,
  request: ChatRequest,
  price: ModelPrice,
  signal: AbortSignal,
): Promise<ChatResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
  const secrets = endpoint.apiKey ? [endpoint.apiKey] : [];
  let response: Response;
  try {
    response = await (endpoint.fetch ?? fetch)(
      `${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ ...request, stream: false }),
        signal,
      },
    );
  } catch (error) {
    if (signal.aborted) return { ok: false, error: { message: "cancelled", retryable: false } };
    return { ok: false, error: { message: errorMessage(error), retryable: true, transient: true } };
  }
  const body = await response.text().catch(() => "");
  if (!response.ok) return { ok: false, error: failure(response, body, secrets) };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: malformed("did not answer with JSON", body, secrets) };
  }
  const reported = errorBodySchema.safeParse(json);
  if (reported.success) {
    return { ok: false, error: failure(response, body, secrets, reported.data.error.code) };
  }
  const parsed = completionSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: malformed("answered without a chat completion", body, secrets) };
  }
  const choice = parsed.data.choices[0] as NonNullable<(typeof parsed.data.choices)[0]>;
  return {
    ok: true,
    content: choice.message.content ?? "",
    toolCalls: choice.message.tool_calls ?? [],
    usage: usageOf(parsed.data.usage, price),
  };
}

// An error status, or an error the endpoint reported inside an OK answer;
// the reported code counts as the status when it is one.
function failure(
  response: Response,
  body: string,
  secrets: readonly string[],
  reportedCode?: number,
): ChatError {
  const inBody = response.ok;
  const status = inBody
    ? reportedCode && reportedCode >= 400
      ? reportedCode
      : 502
    : response.status;
  // An endpoint may echo the request's headers in an error page.
  const shown = excerpt(withoutSecrets(body, secrets));
  const message = inBody ? `error ${status} in an OK answer: ${shown}` : `HTTP ${status}: ${shown}`;
  const quota = parseQuotaError(body, status);
  if (quota && quota.retryAfterMs === undefined) {
    const retryAfter = Number(response.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) quota.retryAfterMs = retryAfter * 1000;
  }
  return {
    message,
    retryable: !AUTH_STATUS.has(status),
    ...(quota ? { quota } : {}),
    ...(!quota && (status >= 500 || status === 408) ? { transient: true } : {}),
  };
}

function malformed(what: string, body: string, secrets: readonly string[]): ChatError {
  return {
    message: `the endpoint ${what}: ${excerpt(withoutSecrets(body, secrets))}`,
    retryable: true,
    transient: true,
  };
}

// Cached tokens are counted inside the prompt tokens, as OpenAI does; they
// are priced at the cached rate when the provider declares one.
function usageOf(usage: z.infer<typeof completionSchema>["usage"], price: ModelPrice): Usage {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = Math.min(prompt, usage?.prompt_tokens_details?.cached_tokens ?? 0);
  const input = prompt - cached;
  const output = usage?.completion_tokens ?? 0;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cachedTokens: cached,
    costUsd:
      input * perToken(price.input) +
      cached * perToken(price.cachedInput ?? price.input) +
      output * perToken(price.output),
  };
}

function excerpt(body: string): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text.length === 0) return "(empty body)";
  return text.length > BODY_EXCERPT ? `${text.slice(0, BODY_EXCERPT)}…` : text;
}
