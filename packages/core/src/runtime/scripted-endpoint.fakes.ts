import { createServer, type Server } from "node:http";

// An OpenAI-compatible endpoint on this machine that answers each request
// with the next scripted reply and records what it was sent.

export interface SeenRequest {
  authorization: string | undefined;
  model: string;
  stream: boolean;
  messages: { role: string; content?: unknown; tool_call_id?: string; tool_calls?: unknown }[];
  tools: { function: { name: string; parameters: Record<string, unknown> } }[] | undefined;
  temperature?: number;
  seed?: number;
  reasoning_effort?: string;
  reasoning?: { effort: string };
}

export interface Reply {
  content?: string;
  // Tool names as the review tools define them; the endpoint uses the name
  // the request offered that ends with it, so a runtime's prefix is fine.
  // `extra` is added to the call as sent, as Gemini adds `extra_content`.
  toolCalls?: { name: string; args: unknown; extra?: object }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
  };
  // An error instead of a completion.
  status?: number;
  body?: string;
  retryAfter?: number;
  // Hold the answer, so that a test can abort meanwhile.
  delayMs?: number;
  // An answer sent as is, as a recorded endpoint gave it.
  raw?: { status: number; body: string };
}

export interface FakeEndpoint {
  url: string;
  seen: SeenRequest[];
  close(): Promise<void>;
}

// Answers a test scripts, one per request, in order; after the script, text
// and no tools. A function instead of a list answers every request. Streams
// when asked to, as OpenCode's client does.
export async function scriptedEndpoint(
  script:
    | readonly (Reply | ((request: SeenRequest) => Reply))[]
    | ((request: SeenRequest) => Reply),
): Promise<FakeEndpoint> {
  const seen: SeenRequest[] = [];
  const replies = typeof script === "function" ? [] : [...script];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end("not found");
        return;
      }
      const parsed = JSON.parse(body) as Omit<SeenRequest, "authorization" | "stream"> & {
        stream?: boolean;
      };
      const request: SeenRequest = {
        ...parsed,
        stream: parsed.stream === true,
        authorization: req.headers.authorization,
      };
      seen.push(request);
      const next =
        typeof script === "function" ? script : (replies.shift() ?? { content: "Done." });
      const reply = typeof next === "function" ? next(request) : next;
      const answer = () => {
        if (reply.raw) {
          res
            .writeHead(reply.raw.status, { "content-type": "application/json" })
            .end(reply.raw.body);
          return;
        }
        if (reply.status !== undefined) {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (reply.retryAfter !== undefined) headers["retry-after"] = String(reply.retryAfter);
          res
            .writeHead(reply.status, headers)
            .end(reply.body ?? `{"error":{"message":"status ${reply.status}"}}`);
          return;
        }
        const completion = completionOf(request, reply, `call-${seen.length}`);
        if (request.stream) streamed(res, completion);
        else
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(completion));
      };
      if (reply.delayMs) setTimeout(answer, reply.delayMs).unref();
      else answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface Completion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: 0;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    };
    finish_reason: "stop" | "tool_calls";
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details: { cached_tokens: number };
    completion_tokens_details: { reasoning_tokens: number };
  };
}

function completionOf(request: SeenRequest, reply: Reply, callId: string): Completion {
  const offered = request.tools?.map((t) => t.function.name) ?? [];
  const toolCalls = reply.toolCalls?.map((call, i) => ({
    id: `${callId}-${i}`,
    type: "function" as const,
    function: {
      name: offered.find((n) => n === call.name || n.endsWith(`_${call.name}`)) ?? call.name,
      arguments: JSON.stringify(call.args),
    },
    ...call.extra,
  }));
  const usage = reply.usage ?? { prompt_tokens: 100, completion_tokens: 10 };
  return {
    id: callId,
    object: "chat.completion",
    created: 1,
    model: request.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: reply.content ?? null,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.prompt_tokens + usage.completion_tokens,
      prompt_tokens_details: { cached_tokens: usage.cached_tokens ?? 0 },
      completion_tokens_details: { reasoning_tokens: usage.reasoning_tokens ?? 0 },
    },
  };
}

function streamed(res: import("node:http").ServerResponse, completion: Completion): void {
  const choice = completion.choices[0] as Completion["choices"][0];
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", created: 1, model: completion.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(chunk({ role: "assistant", content: choice.message.content ?? "" }, null));
  if (choice.message.tool_calls) {
    res.write(
      chunk(
        { tool_calls: choice.message.tool_calls.map((call, index) => ({ index, ...call })) },
        null,
      ),
    );
  }
  res.write(chunk({}, choice.finish_reason, { usage: completion.usage }));
  res.end("data: [DONE]\n\n");
}
