import { createServer, type Server } from "node:http";

// An OpenAI Responses endpoint on this machine, which is what Codex speaks:
// each request gets the next scripted reply, streamed as Codex reads it, and
// is recorded.

export interface SeenResponsesRequest {
  authorization: string | undefined;
  model: string;
  // Tool names as offered, an MCP server's as "<namespace>.<name>".
  tools: string[];
  input: unknown[];
}

export type ResponsesReply =
  | { text: string }
  // A review tool by its own name; the endpoint calls it in the namespace
  // Codex offered it under.
  | { tool: string; args: unknown }
  | { status: number; body: string };

export interface FakeResponses {
  url: string;
  seen: SeenResponsesRequest[];
  close(): Promise<void>;
}

const USAGE = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 40 },
  output_tokens: 20,
  output_tokens_details: { reasoning_tokens: 5 },
  total_tokens: 120,
};

interface OfferedTool {
  type?: string;
  name?: string;
  tools?: OfferedTool[];
}

// After the script, every request is answered with text.
export async function responsesEndpoint(
  script: readonly (ResponsesReply | ((request: SeenResponsesRequest) => ResponsesReply))[],
): Promise<FakeResponses> {
  const seen: SeenResponsesRequest[] = [];
  const replies = [...script];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!req.url?.endsWith("/responses")) {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body) as { model: string; tools?: OfferedTool[]; input: unknown[] };
      const request: SeenResponsesRequest = {
        authorization: req.headers.authorization,
        model: parsed.model,
        tools: offered(parsed.tools ?? []),
        input: parsed.input,
      };
      seen.push(request);
      const next = replies.shift() ?? { text: "Done." };
      const reply = typeof next === "function" ? next(request) : next;
      if ("status" in reply) {
        res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body);
        return;
      }
      const id = `resp_${seen.length}`;
      const item =
        "text" in reply
          ? {
              type: "message",
              id: `msg_${seen.length}`,
              role: "assistant",
              content: [{ type: "output_text", text: reply.text }],
            }
          : {
              type: "function_call",
              id: `fc_${seen.length}`,
              call_id: `call_${seen.length}`,
              ...callName(request.tools, reply.tool),
              arguments: JSON.stringify(reply.args),
            };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id, usage: USAGE } },
      ]) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
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

function offered(tools: readonly OfferedTool[], namespace?: string): string[] {
  return tools.flatMap((t) =>
    t.type === "namespace"
      ? offered(t.tools ?? [], t.name)
      : [namespace ? `${namespace}.${t.name ?? t.type}` : (t.name ?? t.type ?? "")],
  );
}

function callName(tools: readonly string[], tool: string): { name: string; namespace?: string } {
  const full = tools.find((t) => t === tool || t.endsWith(`.${tool}`)) ?? tool;
  const dot = full.lastIndexOf(".");
  return dot < 0 ? { name: full } : { namespace: full.slice(0, dot), name: full.slice(dot + 1) };
}
