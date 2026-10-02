import { createServer, type Server } from "node:http";

export interface SeenRequest {
  authorization: string | undefined;
  model: string;
  messages: {
    role: string;
    content?: string | null;
    tool_call_id?: string;
    tool_calls?: unknown;
  }[];
  tools: { function: { name: string; parameters: Record<string, unknown> } }[] | undefined;
}

export interface Reply {
  content?: string;
  toolCalls?: { name: string; args: unknown }[];
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
}

export interface FakeEndpoint {
  url: string;
  seen: SeenRequest[];
  close(): Promise<void>;
}

// An OpenAI-compatible chat endpoint on this machine whose answers a test
// scripts, one per request, in order; after the script it answers with
// text and no tools.
export async function scriptedEndpoint(
  script: readonly (Reply | ((request: SeenRequest) => Reply))[],
): Promise<FakeEndpoint> {
  const seen: SeenRequest[] = [];
  const replies = [...script];
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
      const parsed = JSON.parse(body) as Omit<SeenRequest, "authorization">;
      const request: SeenRequest = { ...parsed, authorization: req.headers.authorization };
      seen.push(request);
      const next = replies.shift() ?? { content: "Done." };
      const reply = typeof next === "function" ? next(request) : next;
      const answer = () => {
        if (reply.status !== undefined) {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (reply.retryAfter !== undefined) headers["retry-after"] = String(reply.retryAfter);
          res
            .writeHead(reply.status, headers)
            .end(reply.body ?? `{"error":"status ${reply.status}"}`);
          return;
        }
        const usage = reply.usage ?? { prompt_tokens: 100, completion_tokens: 10 };
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: "c",
            object: "chat.completion",
            model: request.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: reply.content ?? null,
                  ...(reply.toolCalls
                    ? {
                        tool_calls: reply.toolCalls.map((call, i) => ({
                          id: `call-${seen.length}-${i}`,
                          type: "function",
                          function: { name: call.name, arguments: JSON.stringify(call.args) },
                        })),
                      }
                    : {}),
                },
                finish_reason: reply.toolCalls ? "tool_calls" : "stop",
              },
            ],
            usage: {
              prompt_tokens: usage.prompt_tokens,
              completion_tokens: usage.completion_tokens,
              total_tokens: usage.prompt_tokens + usage.completion_tokens,
              prompt_tokens_details: { cached_tokens: usage.cached_tokens ?? 0 },
              completion_tokens_details: { reasoning_tokens: usage.reasoning_tokens ?? 0 },
            },
          }),
        );
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
