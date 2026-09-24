import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { errorMessage, type ReviewContext, type ToolDefinition } from "@open-cr-agent/core";

export interface ToolServer {
  url: string;
  headers: Record<string, string>;
  close(): Promise<void>;
}

export async function startToolServer(
  tools: readonly ToolDefinition[],
  context: () => ReviewContext | undefined,
): Promise<ToolServer> {
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);

  const http = createServer(async (req, res) => {
    if (!authorized(req, expected)) {
      res.writeHead(401).end();
      return;
    }
    const mcp = buildMcpServer(tools, context);
    const transport = new StreamableHTTPServerTransport({});
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    // The SDK's transport types are not written for exactOptionalPropertyTypes.
    await mcp.connect(transport as unknown as Parameters<McpServer["connect"]>[0]);
    await transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

function buildMcpServer(
  tools: readonly ToolDefinition[],
  context: () => ReviewContext | undefined,
): McpServer {
  const mcp = new McpServer({ name: "ocra", version: "0.0.0" });
  for (const tool of tools) {
    mcp.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema.shape },
      async (args) => {
        const ctx = context();
        if (!ctx) return failure("No review is running.");
        try {
          return { content: [{ type: "text" as const, text: await tool.execute(args, ctx) }] };
        } catch (error) {
          return failure(errorMessage(error));
        }
      },
    );
  }
  return mcp;
}

function failure(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function authorized(req: IncomingMessage, expected: Buffer): boolean {
  const actual = Buffer.from(req.headers.authorization ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
