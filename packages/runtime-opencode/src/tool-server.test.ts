import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ReviewContext } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_READ_LINES, reviewTools } from "./review-tools.js";
import { startToolServer, type ToolServer } from "./tool-server.js";

const file = Array.from({ length: MAX_READ_LINES + 5 }, (_, i) => `line ${i + 1}`).join("\n");
const context: ReviewContext = {
  readFile: async (path) => (path === "big.ts" ? file : undefined),
  readDiff: (path) => (path === "a.ts" ? "@@ -1 +1 @@\n-a\n+b" : undefined),
  searchCode: async (literal) =>
    Array.from({ length: 55 }, (_, i) => ({ path: `f${i}.ts`, line: i + 1, text: `${literal}()` })),
};

const servers: ToolServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function connect(ctx: ReviewContext | undefined) {
  const failing = {
    name: "explode",
    description: "always fails",
    inputSchema: z.object({}),
    execute: async () => {
      throw new Error("boom");
    },
  };
  const server = await startToolServer([...reviewTools, failing], () => ctx);
  servers.push(server);
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers },
  });
  // The SDK's transport types are not written for exactOptionalPropertyTypes.
  await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { text: string }[];
  return { text: first?.text ?? "", isError: result.isError === true };
}

describe("tool server", () => {
  it("serves the review tools over MCP", async () => {
    const client = await connect(context);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "read_file",
      "read_diff",
      "code_search",
      "report_finding",
      "task_done",
      "explode",
    ]);
    await client.close();
  });

  it("reads files with line numbers and pages long files", async () => {
    const client = await connect(context);
    const first = await call(client, "read_file", { path: "big.ts" });
    expect(first.text.split("\n")[0]).toBe("1: line 1");
    expect(first.text).toContain(
      `[truncated: 5 more lines; call again with startLine=${MAX_READ_LINES + 1}]`,
    );
    const next = await call(client, "read_file", { path: "big.ts", startLine: MAX_READ_LINES + 1 });
    expect(next.text.split("\n")[0]).toBe(`${MAX_READ_LINES + 1}: line ${MAX_READ_LINES + 1}`);
    expect((await call(client, "read_file", { path: "nope.ts" })).text).toBe(
      "File not found: nope.ts",
    );
    await client.close();
  });

  it("reads diffs and caps search results", async () => {
    const client = await connect(context);
    expect((await call(client, "read_diff", { path: "a.ts" })).text).toContain("+b");
    expect((await call(client, "read_diff", { path: "z.ts" })).text).toBe(
      "No changes to z.ts in this change.",
    );
    const search = await call(client, "code_search", { literal: "run" });
    expect(search.text.split("\n")[0]).toBe("f0.ts:1: run()");
    expect(search.text).toContain("[5 more matches omitted]");
    await client.close();
  });

  it("acknowledges findings and reports tool errors without crashing", async () => {
    const client = await connect(context);
    const recorded = await call(client, "report_finding", {
      file: "a.ts",
      existingCode: "b",
      severity: "warning",
      title: "t",
      body: "b",
    });
    expect(recorded).toEqual({ text: "Recorded.", isError: false });
    expect(await call(client, "explode")).toEqual({ text: "Error: boom", isError: true });
    await client.close();
  });

  it("rejects requests without the bearer token", async () => {
    const server = await startToolServer(reviewTools, () => context);
    servers.push(server);
    const response = await fetch(server.url, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    const wrong = await fetch(server.url, {
      method: "POST",
      body: "{}",
      headers: { Authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
  });

  it("answers with an error when no review is running", async () => {
    const client = await connect(undefined);
    expect(await call(client, "read_file", { path: "big.ts" })).toEqual({
      text: "Error: No review is running.",
      isError: true,
    });
    await client.close();
  });
});
