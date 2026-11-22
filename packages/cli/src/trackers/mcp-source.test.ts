import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { trackerSources } from "./sources.js";

// A Jira MCP server answered in process: fetch goes straight to its transport.
function jiraServer(seen: { args: unknown[]; auth: (string | null)[] }) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.auth.push(request.headers.get("authorization"));
    const server = new McpServer({ name: "jira", version: "1" });
    server.registerTool(
      "jira_get_issue",
      { inputSchema: { issue_key: z.string(), expand: z.string().optional() } },
      async (args) => {
        seen.args.push(args);
        const issue = {
          fields: { summary: `Summary of ${args.issue_key}`, status: "In Progress" },
        };
        return { content: [{ type: "text", text: JSON.stringify(issue) }] };
      },
    );
    // No session id generator: a stateless server, as the client meets it per task.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  }) as typeof fetch;
}

const config = {
  jira: {
    projects: ["PAY"],
    server: { url: "https://mcp.example.com/jira", tokenEnv: "JIRA_MCP_TOKEN" },
    tool: "jira_get_issue",
    keyArgument: "issue_key",
    arguments: { expand: "none" },
  },
};

describe("a tracker's MCP server", () => {
  it("is asked for each named key with the configured tool, arguments and token", async () => {
    const seen = { args: [] as unknown[], auth: [] as (string | null)[] };
    const [jira] = trackerSources(config, { JIRA_MCP_TOKEN: "secret" }, jiraServer(seen));
    expect(jira?.keysIn("PAY-12 retry")).toEqual(["PAY-12"]);
    const task = await jira?.fetch("PAY-12", new AbortController().signal);
    expect(task).toMatchObject({
      tracker: "jira",
      key: "PAY-12",
      title: "Summary of PAY-12",
      state: "open",
    });
    expect(seen.args).toEqual([{ issue_key: "PAY-12", expand: "none" }]);
    expect(seen.auth.every((a) => a === "Bearer secret")).toBe(true);
  });

  it("is not called when its token is missing", async () => {
    const seen = { args: [] as unknown[], auth: [] as (string | null)[] };
    const [jira] = trackerSources(config, {}, jiraServer(seen));
    await expect(jira?.fetch("PAY-12", new AbortController().signal)).rejects.toThrow(
      "JIRA_MCP_TOKEN is not set",
    );
    expect(seen.auth).toEqual([]);
  });
});
