import { OcraError } from "@open-cr-agent/core";
import { findRepositoryRoot } from "@open-cr-agent/vcs-local/internal";
import { EXIT } from "../io/exit.js";
import type { Output } from "../io/output.js";
import { VERSION } from "../version.js";
import type { ReviewDeps } from "./review/deps.js";
import type { ReviewIo } from "./review/resolve-run.js";
import { reviewOnce } from "./review/review-once.js";

export const MCP_USAGE = `Usage: ocra mcp

Serves ocra as a Model Context Protocol server on standard input and output,
for a coding agent such as Claude Code, Cursor or Codex: its one tool,
"review", reviews this repository as ocra review would.

Options:
  -h, --help  Show help
`;

const SDK = "@modelcontextprotocol/sdk";
const discard: Output = { write: () => {} };

// Standard output carries the protocol, so the review's own output goes
// nowhere and messages for people go to standard error.
export async function mcpCommand(err: Output, deps: ReviewDeps): Promise<number> {
  const root = await findRepositoryRoot(deps.cwd);
  const { mcpServer, stdioTransport } = await loadServer();
  const io: ReviewIo = { out: discard, err };
  const server = mcpServer(VERSION, (request, signal, onEvent) =>
    reviewOnce(request, signal, onEvent, io, deps),
  );
  const transport = stdioTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
    const stop = deps.onInterrupt?.(() => {
      stop?.();
      resolve();
    });
  });
  await server.connect(transport);
  err.write(`[ocra] MCP server for ${root} on standard input and output\n`);
  await closed;
  await server.close();
  return EXIT.ok;
}

// The SDK comes with the OpenCode runtime, an optional dependency (ADR-0050).
async function loadServer() {
  try {
    const [{ mcpServer }, { StdioServerTransport }] = await Promise.all([
      import("../mcp/server.js"),
      import("@modelcontextprotocol/sdk/server/stdio.js"),
    ]);
    return { mcpServer, stdioTransport: () => new StdioServerTransport() };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== "ERR_MODULE_NOT_FOUND" || !String(error).includes(`'${SDK}'`)) throw error;
    throw new OcraError(
      "CONFIG_INVALID",
      `ocra mcp needs ${SDK}, which comes with ocra's optional dependencies ` +
        "(left out by --omit=optional). Reinstall ocra without --omit=optional.",
      { cause: error },
    );
  }
}
