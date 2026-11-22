import {
  type Env,
  type LinkedTask,
  OcraError,
  type TaskSource,
  type TaskTracker,
} from "@open-cr-agent/core";
import { VERSION } from "../version.js";
import { type ToolResult, taskFromResult } from "./tool-result.js";

const SDK = "@modelcontextprotocol/sdk";
const CALL_TIMEOUT_MS = 20_000;

export interface McpTracker {
  tracker: TaskTracker;
  server: { url: string; tokenEnv?: string | undefined };
  keysIn(text: string): string[];
  // The tool and its arguments that read one task; undefined for a key the
  // configuration names no tool for.
  call(key: string): { tool: string; arguments: Record<string, string> } | undefined;
}

// Reads tasks through a tracker's MCP server, one connection per task: a
// review reads at most three, and nothing is left open when it ends.
export function mcpTaskSource(
  spec: McpTracker,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): TaskSource {
  return {
    tracker: spec.tracker,
    keysIn: spec.keysIn,
    async fetch(key: string, signal: AbortSignal): Promise<LinkedTask | undefined> {
      const call = spec.call(key);
      if (!call) return undefined;
      const { Client, StreamableHTTPClientTransport } = await loadClient();
      const token = spec.server.tokenEnv ? env[spec.server.tokenEnv] : undefined;
      if (spec.server.tokenEnv && !token) {
        throw new OcraError("CONFIG_INVALID", `${spec.server.tokenEnv} is not set`);
      }
      const transport = new StreamableHTTPClientTransport(new URL(spec.server.url), {
        fetch: fetchImpl,
        ...(token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}),
      });
      const client = new Client({ name: "ocra", version: VERSION });
      try {
        await client.connect(transport, { signal, timeout: CALL_TIMEOUT_MS });
        const result = await client.callTool(
          { name: call.tool, arguments: call.arguments },
          undefined,
          { signal, timeout: CALL_TIMEOUT_MS },
        );
        return taskFromResult(spec.tracker, key, result as ToolResult);
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}

// The SDK is an optional dependency (ADR-0050).
async function loadClient() {
  try {
    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    ]);
    return { Client, StreamableHTTPClientTransport };
  } catch (error) {
    throw new OcraError(
      "CONFIG_INVALID",
      `reading tracker tasks needs ${SDK}, which comes with ocra's optional dependencies (left out by --omit=optional)`,
      { cause: error },
    );
  }
}
