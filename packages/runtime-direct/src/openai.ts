import {
  errorMessage,
  type ModelPrice,
  parseQuotaError,
  type QuotaError,
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
}

export type ChatResponse =
  | { ok: true; content: string; toolCalls: ToolCall[]; usage: Usage }
  | { ok: false; error: ChatError };

const AUTH_STATUS = new Set([401, 403]);
// How much of an error body an error message keeps: enough to diagnose, not
// a page of HTML.
const BODY_EXCERPT = 300;

export function toolSpec(tool: ToolDefinition): ToolSpec {
  const { $schema: _, ...parameters } = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters },
  };
}

// One request to the endpoint. Only the key named for this provider goes
// out, and only to its base URL; nothing is retried here, the failback
// decides what a failure means.
export async function chat(
  endpoint: Endpoint,
  request: ChatRequest,
  price: ModelPrice,
  signal: AbortSignal,
): Promise<ChatResponse> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
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
    const message = signal.aborted ? "cancelled" : errorMessage(error);
    return { ok: false, error: { message, retryable: !signal.aborted } };
  }
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    // An endpoint may echo the request's headers in an error page.
    const shown = withoutSecrets(body, endpoint.apiKey ? [endpoint.apiKey] : []);
    const message = `HTTP ${response.status}: ${excerpt(shown)}`;
    const quota = parseQuotaError(body, response.status);
    if (quota && quota.retryAfterMs === undefined) {
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) quota.retryAfterMs = retryAfter * 1000;
    }
    return {
      ok: false,
      error: { message, retryable: !AUTH_STATUS.has(response.status), ...(quota ? { quota } : {}) },
    };
  }
  let parsed: ReturnType<typeof completionSchema.safeParse>;
  try {
    parsed = completionSchema.safeParse(JSON.parse(body));
  } catch {
    return {
      ok: false,
      error: { message: "the endpoint did not answer with JSON", retryable: true },
    };
  }
  if (!parsed.success) {
    return {
      ok: false,
      error: { message: "the endpoint's answer is not a chat completion", retryable: true },
    };
  }
  const choice = parsed.data.choices[0] as NonNullable<(typeof parsed.data.choices)[0]>;
  return {
    ok: true,
    content: choice.message.content ?? "",
    toolCalls: choice.message.tool_calls ?? [],
    usage: usageOf(parsed.data.usage, price),
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
  return text.length > BODY_EXCERPT ? `${text.slice(0, BODY_EXCERPT)}…` : text;
}
