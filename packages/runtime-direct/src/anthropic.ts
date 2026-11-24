import Anthropic from "@anthropic-ai/sdk";
import {
  type Effort,
  errorMessage,
  fetchFailure,
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
  transientStatus,
  type Wire,
  withoutEffort,
} from "./wire.js";

// Room for an answer with its reasoning; the protocol requires a cap.
const MAX_OUTPUT_TOKENS = 32_000;
// Anthropic charges a quarter above the input rate for input it stores.
const CACHE_WRITE_FACTOR = 1.25;
const CACHED = { cache_control: { type: "ephemeral" } } as const;
// The API takes four cache marks a request: the newest block's and these. A
// conversation whose first message has no shared start marks its system
// prompt instead; one that has needs no mark there, since the first shared
// start holds the system prompt. A dialogue of one request leaves its newest
// block unmarked and has that mark for a shared start too.
const MAX_SHARED_MARKS = 3;
// How the API names the effort parameters in a 400 that refuses them.
const EFFORT_PARAMETER = /\b(?:effort|output_config|thinking)\b/i;
// The API has no level under "low", and its newer models cannot stop
// reasoning, so the two lowest levels go as "low".
const LEVELS: Record<Effort, "low" | "medium" | "high"> = {
  none: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
};

type Request = Anthropic.MessageStreamParams;
type Turn = Exclude<Anthropic.MessageParam, { role: "system" }>;

// A conversation in Anthropic's Messages protocol, streamed so a long answer
// does not sit behind an idle connection. The system prompt and the
// conversation so far are marked for the provider's prompt cache at every
// request: an agent's next step reads what the last one stored. A start the
// run's other conversations open with is marked too, so they read it from
// the first that stored it (ADR-0064). A dialogue of one request has no next
// step, and storing costs a quarter more than sending, so its conversation
// goes unmarked but for a shared start; its system prompt stays marked for
// the other calls of its kind. The first request waits for the answer to another that is storing
// the same start to begin (ADR-0072).
export const anthropicWire: Wire = ({ endpoint, model, price, system, oneRequest, starts }) => {
  const client = clientOf(endpoint);
  const secrets = endpoint.apiKey ? [endpoint.apiKey] : [];
  const messages: Turn[] = [];
  // What the first request stores for the run's other conversations.
  let opening: string | undefined;
  let sharesStart = false;

  return {
    say: (text, shared = []) => {
      const ends = sharedEnds(text, shared);
      const [first] = ends;
      if (messages.length === 0 && first !== undefined) {
        opening = [endpoint.baseUrl, model, system, text.slice(0, first)].join("\0");
        sharesStart = true;
      }
      const marks = oneRequest ? MAX_SHARED_MARKS + 1 : MAX_SHARED_MARKS;
      messages.push({ role: "user", content: textBlocks(text, ends, marks) });
    },
    ask: async (tools, settings, signal): Promise<Answer> => {
      const begun = opening === undefined ? undefined : await starts?.claim(opening, signal);
      opening = undefined;
      const send = (request: Request) =>
        onceMore(() => stream(client, request, price, secrets, signal, begun), signal).finally(
          begun,
        );
      const request = (sent: CallSettings): Request => ({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [{ type: "text", text: system, ...(sharesStart ? {} : CACHED) }],
        messages: oneRequest ? messages : withBreakpoint(messages),
        ...(tools.length > 0 ? { tools: tools.map(toolSpec) } : {}),
        ...effortParams(sent.effort),
      });
      let reply = await send(request(settings));
      let dropped = false;
      if (!reply.ok && reply.error.effortRefused && settings.effort !== undefined) {
        reply = await send(request(withoutEffort(settings)));
        dropped = true;
      }
      const effortDropped = dropped ? { effortDropped: true as const } : {};
      if (!reply.ok) return { ...reply, ...effortDropped };
      const { content } = reply.message;
      if (content.length > 0) messages.push({ role: "assistant", content });
      return {
        ok: true,
        text: content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
        calls: content.flatMap((block) =>
          block.type === "tool_use" ? [{ id: block.id, name: block.name, input: block.input }] : [],
        ),
        usage: reply.usage,
        ...effortDropped,
      };
    },
    answer: (outputs) => {
      messages.push({
        role: "user",
        content: outputs.map(({ call, output }) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: output,
        })),
      });
    },
  };
};

// A key is always given, an empty one for an endpoint that takes none (its
// header is then left out), so the SDK never looks for a credential of its
// own in the environment or on disk: only the key named for this provider
// goes out, and only to its base URL.
function clientOf(endpoint: Endpoint): Anthropic {
  return new Anthropic({
    baseURL: endpoint.baseUrl.replace(/\/$/, ""),
    apiKey: endpoint.apiKey ?? "",
    ...(endpoint.apiKey ? {} : { defaultHeaders: { authorization: null } }),
    maxRetries: 0,
    logLevel: "off",
    ...(endpoint.fetch ? { fetch: endpoint.fetch } : {}),
  });
}

function toolSpec(tool: ToolDefinition): Anthropic.Tool {
  const { $schema: _, ...schema } = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema as Anthropic.Tool.InputSchema,
  };
}

function effortParams(effort: Effort | undefined): Pick<Request, "output_config" | "thinking"> {
  if (effort === undefined) return {};
  return {
    output_config: { effort: LEVELS[effort] },
    ...(effort === "none" ? {} : { thinking: { type: "adaptive" } }),
  };
}

function sharedEnds(text: string, shared: readonly number[]): number[] {
  return shared.filter((end) => end > 0 && end < text.length);
}

// The text as blocks that end where a shared start does: together they read
// as the text does. The first `marks` are stored; a later one only ends a
// block, which is where a request looks for what another stored.
function textBlocks(
  text: string,
  ends: readonly number[],
  marks: number,
): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [];
  let from = 0;
  for (const [i, end] of ends.entries()) {
    blocks.push({ type: "text", text: text.slice(from, end), ...(i < marks ? CACHED : {}) });
    from = end;
  }
  return [...blocks, { type: "text", text: text.slice(from) }];
}

// The last block of the conversation carries the cache mark; the stored
// messages stay unmarked, so each request has one.
function withBreakpoint(messages: readonly Turn[]): Turn[] {
  const last = messages.at(-1);
  if (!last || typeof last.content === "string") return [...messages];
  const blocks = last.content;
  const tail = blocks.at(-1);
  if (tail?.type !== "text" && tail?.type !== "tool_result") return [...messages];
  return [
    ...messages.slice(0, -1),
    { ...last, content: [...blocks.slice(0, -1), { ...tail, ...CACHED }] },
  ];
}

type Reply =
  | { ok: true; message: Anthropic.Message; usage: Usage }
  | { ok: false; error: CallError };

async function stream(
  client: Anthropic,
  request: Request,
  price: ModelPrice,
  secrets: readonly string[],
  signal: AbortSignal,
  begun?: () => void,
): Promise<Reply> {
  let message: Anthropic.Message;
  try {
    const answer = client.messages.stream(request, { signal });
    if (begun) answer.once("streamEvent", begun);
    message = await answer.finalMessage();
  } catch (error) {
    if (signal.aborted) return { ok: false, error: { message: "cancelled", retryable: false } };
    return { ok: false, error: failure(error, secrets) };
  }
  const cut = cutOff(message);
  if (cut) return { ok: false, error: { message: cut, retryable: true } };
  return { ok: true, message, usage: usageOf(message.usage, price) };
}

// Why an answer cannot be used as it is. One cut off inside a tool call
// would run the tool on half its input.
function cutOff(message: Anthropic.Message): string | undefined {
  switch (message.stop_reason) {
    case "refusal":
      return `the model declined to answer${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}`;
    case "max_tokens":
      return `the answer was cut off at ${MAX_OUTPUT_TOKENS} output tokens`;
    case "model_context_window_exceeded":
      return "the conversation no longer fits the model's context window";
    default:
      return undefined;
  }
}

function failure(error: unknown, secrets: readonly string[]): CallError {
  // An endpoint may echo the request's headers in an error.
  const text = (message: string) => excerpt(withoutSecrets(message, secrets));
  if (!(error instanceof Anthropic.APIError) || error.status === undefined) {
    // No status: the connection failed, or the stream was not one the SDK
    // could read to its end.
    return { message: text(fetchFailure(error)), retryable: true, transient: true };
  }
  const shown = text(errorMessage(error));
  const { status } = error;
  const quota = parseQuotaError(shown, status);
  if (quota && quota.retryAfterMs === undefined) {
    const retryAfter = Number(error.headers?.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) quota.retryAfterMs = retryAfter * 1000;
  }
  return {
    message: `HTTP ${shown}`,
    retryable: retryableStatus(status),
    ...(status === 400 && EFFORT_PARAMETER.test(shown) ? { effortRefused: true } : {}),
    ...(quota ? { quota } : {}),
    ...(!quota && transientStatus(status) ? { transient: true } : {}),
  };
}

// Anthropic counts cached input apart from fresh input, and reasoning
// inside the output.
function usageOf(usage: Anthropic.Usage, price: ModelPrice): Usage {
  return pricedUsage(
    {
      input: usage.input_tokens,
      cached: usage.cache_read_input_tokens ?? 0,
      written: usage.cache_creation_input_tokens ?? 0,
      output: usage.output_tokens,
      reasoning: usage.output_tokens_details?.thinking_tokens ?? 0,
    },
    price,
    CACHE_WRITE_FACTOR,
  );
}
