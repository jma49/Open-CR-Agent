import {
  type Effort,
  errorMessage,
  type ModelPrice,
  parseQuotaError,
  type ToolDefinition,
  type Usage,
  withoutSecrets,
} from "@open-cr-agent/core";
import { z } from "zod";
import {
  type Answer,
  type CallError,
  type CallSettings,
  type Endpoint,
  excerpt,
  onceMore,
  pricedUsage,
  retryableStatus,
  type ToolRequest,
  transientStatus,
  type Wire,
} from "./wire.js";

// The subset of the OpenAI chat completions protocol the loop needs: one
// choice, its text and tool calls, and the token counts. Anything else an
// endpoint adds is dropped at this boundary, except a tool call's
// `extra_content`: Gemini 3 puts its thought signature there and refuses the
// next request unless the call comes back with it.
const toolCallSchema = z
  .object({
    id: z.string(),
    function: z.object({ name: z.string(), arguments: z.string() }),
    extra_content: z.record(z.string(), z.unknown()).optional(),
  })
  // A call goes back with its type, which Vertex AI requires.
  .transform((call) => ({ ...call, type: "function" as const }));
const choiceSchema = z.object({
  message: z.object({
    content: z.string().nullable().optional(),
    tool_calls: z.array(toolCallSchema).optional(),
  }),
});
const completionSchema = z.object({
  // At least one: the first is the answer.
  choices: z.tuple([choiceSchema], choiceSchema),
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

type ToolCall = z.output<typeof toolCallSchema>;

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface ChatRequest {
  model: string;
  messages: readonly ChatMessage[];
  tools?: readonly ToolSpec[];
  temperature?: number;
  seed?: number;
  // One of the two, by the provider's declaration.
  reasoning_effort?: Effort;
  reasoning?: { effort: Effort };
}

export type EffortStyle = "openai" | "openrouter";

type ChatResponse = (
  | { ok: true; content: string; toolCalls: ToolCall[]; usage: Usage }
  | { ok: false; error: CallError }
) & { effortDropped?: true };

// How an endpoint names the effort parameters in a 400 that refuses them.
const EFFORT_PARAMETER = /\breasoning(?:_effort)?\b/i;

// A conversation in OpenAI's chat completions protocol, with the effort sent
// the way the provider declares.
export function openaiWire(style: EffortStyle = "openai"): Wire {
  return ({ endpoint, model, price, system }) => {
    const messages: ChatMessage[] = [{ role: "system", content: system }];
    return {
      say: (text) => {
        messages.push({ role: "user", content: text });
      },
      ask: async (tools, settings, signal): Promise<Answer> => {
        const specs = tools.map(toolSpec);
        const request = {
          model,
          messages,
          ...(specs.length > 0 ? { tools: specs } : {}),
          ...params(settings, style),
        };
        const response = await chat(endpoint, request, price, signal);
        const dropped = response.effortDropped ? { effortDropped: true as const } : {};
        if (!response.ok) return { ...response, ...dropped };
        const { content, toolCalls, usage } = response;
        messages.push({
          role: "assistant",
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        return { ok: true, text: content, calls: toolCalls.map(toolRequest), usage, ...dropped };
      },
      answer: (outputs) => {
        for (const { call, output } of outputs) {
          messages.push({ role: "tool", tool_call_id: call.id, content: output });
        }
      },
    };
  };
}

function params(
  { effort, ...sampling }: CallSettings,
  style: EffortStyle,
): Pick<ChatRequest, "temperature" | "seed" | "reasoning_effort" | "reasoning"> {
  if (effort === undefined) return sampling;
  return {
    ...sampling,
    ...(style === "openrouter" ? { reasoning: { effort } } : { reasoning_effort: effort }),
  };
}

function toolRequest(call: ToolCall): ToolRequest {
  const { id } = call;
  const { name } = call.function;
  try {
    return { id, name, input: JSON.parse(call.function.arguments || "{}") };
  } catch {
    return { id, name, input: undefined, malformed: true };
  }
}

function toolSpec(tool: ToolDefinition): ToolSpec {
  const { $schema: _, ...parameters } = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters },
  };
}

// One request to the endpoint. A refused effort parameter is not the model's
// failure: the request goes once more without it, so the review still runs
// and the failback chain does not move.
async function chat(
  endpoint: Endpoint,
  request: ChatRequest,
  price: ModelPrice,
  signal: AbortSignal,
): Promise<ChatResponse> {
  const sent = (body: ChatRequest) => onceMore(() => send(endpoint, body, price, signal), signal);
  const first = await sent(request);
  if (first.ok || !first.error.effortRefused || !hasEffort(request)) return first;
  return { ...(await sent(withoutEffort(request))), effortDropped: true };
}

function hasEffort(request: ChatRequest): boolean {
  return request.reasoning_effort !== undefined || request.reasoning !== undefined;
}

function withoutEffort(request: ChatRequest): ChatRequest {
  const { reasoning_effort: _effort, reasoning: _reasoning, ...rest } = request;
  return rest;
}

// Only the key named for this provider goes out, and only to its base URL.
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
    return {
      ok: false,
      error: {
        message: errorMessage(error),
        retryable: true,
        transient: true,
      },
    };
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
  const [choice] = parsed.data.choices;
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
): CallError {
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
    retryable: retryableStatus(status),
    ...(status === 400 && EFFORT_PARAMETER.test(body) ? { effortRefused: true } : {}),
    ...(quota ? { quota } : {}),
    ...(!quota && transientStatus(status) ? { transient: true } : {}),
  };
}

function malformed(what: string, body: string, secrets: readonly string[]): CallError {
  return {
    message: `the endpoint ${what}: ${excerpt(withoutSecrets(body, secrets))}`,
    retryable: true,
    transient: true,
  };
}

// Cached tokens are counted inside the prompt tokens, as OpenAI does.
function usageOf(usage: z.infer<typeof completionSchema>["usage"], price: ModelPrice): Usage {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = Math.min(prompt, usage?.prompt_tokens_details?.cached_tokens ?? 0);
  return pricedUsage(
    {
      input: prompt - cached,
      cached,
      output: usage?.completion_tokens ?? 0,
      reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    },
    price,
  );
}
