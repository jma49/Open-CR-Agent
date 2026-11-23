import { createServer, type ServerResponse } from "node:http";

// An endpoint on this machine that speaks Anthropic's Messages protocol:
// each request gets the next scripted reply as a stream of events, and what
// was sent is kept.

interface SeenMessages {
  // How many answers had begun when the request arrived.
  answersBegun: number;
  apiKey: string | undefined;
  authorization: string | undefined;
  body: {
    model: string;
    stream?: boolean;
    max_tokens: number;
    system?: unknown;
    messages: { role: string; content: Record<string, unknown>[] }[];
    tools?: { name: string; input_schema: Record<string, unknown> }[];
    output_config?: { effort?: string };
    thinking?: { type: string };
    temperature?: number;
  };
}

export interface MessagesReply {
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
  stopReason?: string;
  usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number };
  // How long the answer takes to begin.
  afterMs?: number;
  // An error instead of a message.
  status?: number;
  body?: string;
  retryAfter?: number;
}

export interface FakeMessages {
  url: string;
  seen: SeenMessages[];
  close(): Promise<void>;
}

export async function messagesEndpoint(script: readonly MessagesReply[]): Promise<FakeMessages> {
  const seen: SeenMessages[] = [];
  const replies = [...script];
  let answersBegun = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/messages") {
        res.writeHead(404).end("not found");
        return;
      }
      const header = (name: string) => {
        const value = req.headers[name];
        return typeof value === "string" ? value : undefined;
      };
      seen.push({
        answersBegun,
        apiKey: header("x-api-key"),
        authorization: header("authorization"),
        body: JSON.parse(body),
      });
      const reply = replies.shift() ?? { text: "Done." };
      if (reply.status !== undefined) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (reply.retryAfter !== undefined) headers["retry-after"] = String(reply.retryAfter);
        res
          .writeHead(reply.status, headers)
          .end(
            reply.body ??
              `{"type":"error","error":{"type":"api_error","message":"status ${reply.status}"}}`,
          );
        return;
      }
      const turn = seen.length;
      setTimeout(() => {
        answersBegun += 1;
        streamed(res, reply, turn);
      }, reply.afterMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function streamed(res: ServerResponse, reply: MessagesReply, turn: number): void {
  const calls = reply.toolCalls ?? [];
  const usage = {
    input_tokens: reply.usage?.input ?? 100,
    cache_read_input_tokens: reply.usage?.cacheRead ?? 0,
    cache_creation_input_tokens: reply.usage?.cacheWrite ?? 0,
  };
  const events: [string, object][] = [
    [
      "message_start",
      {
        message: {
          id: `msg_${turn}`,
          type: "message",
          role: "assistant",
          model: "fake",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...usage, output_tokens: 0 },
        },
      },
    ],
  ];
  let index = 0;
  const block = (start: object, delta: object) => {
    events.push(
      ["content_block_start", { index, content_block: start }],
      ["content_block_delta", { index, delta }],
      ["content_block_stop", { index }],
    );
    index += 1;
  };
  if (reply.text) {
    block({ type: "text", text: "" }, { type: "text_delta", text: reply.text });
  }
  for (const [i, call] of calls.entries()) {
    block(
      { type: "tool_use", id: `toolu_${turn}_${i}`, name: call.name, input: {} },
      { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
    );
  }
  events.push(
    [
      "message_delta",
      {
        delta: {
          stop_reason: reply.stopReason ?? (calls.length > 0 ? "tool_use" : "end_turn"),
          stop_sequence: null,
        },
        usage: { output_tokens: reply.usage?.output ?? 10 },
      },
    ],
    ["message_stop", {}],
  );
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [type, data] of events) {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  }
  res.end();
}
