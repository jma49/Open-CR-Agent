# ADR-0005: Deliver review tools to the agent runtime over in-process MCP

- Status: accepted
- Date: 2026-09-24
- Refines: [ADR-0003](0003-opencode-runtime.md)

## Context

ADR-0003 planned to register review tools through an OpenCode plugin. [Spike 0001](../spikes/0001-opencode-runtime.md) showed:

- OpenCode loads plugins only from a `plugins/` directory, either inside the reviewed repository or under `OPENCODE_CONFIG_DIR`.
- An OpenCode plugin runs inside the OpenCode process. Our orchestrator runs outside it (ADR-0003), and tools must answer from the revision under review through `ReviewContext`, so a plugin would still need a channel back to our process.
- A remote MCP server hosted by our process works, needs no files in the reviewed repository, returns findings as structured calls, and used fewer tokens than OpenCode's built-in tools.

Two plugin layers must not be confused. **ocra plugins** (VCS adapters, model providers, reviewers, rule packs, telemetry) are the core extension model, following Cloudflare's `ReviewPlugin` design. **OpenCode plugins** are a runtime implementation detail.

## Decision

- `runtime-opencode` hosts review tools (`read_file`, `read_diff`, `code_search`, `report_finding`, `task_done`) on an MCP server inside the ocra process, bound to `127.0.0.1` and protected by a per-run random bearer token, and registers it as a remote MCP server in the OpenCode config.
- All OpenCode built-in tools are disabled for reviewer agents.
- OpenCode plugins, loaded from an ocra-owned `OPENCODE_CONFIG_DIR`, are reserved for hooks that must run inside OpenCode (for example system prompt or model parameter transforms, runtime telemetry). None is needed yet.
- Tools contributed by ocra plugins (for example a reviewer that needs a schema lookup) are served through the same MCP server.

## Consequences

- Tools are runtime-agnostic: any runtime that speaks MCP (Pi, Codex, Goose) can reuse them.
- The runtime maps provider keys for OpenCode (for example `GEMINI_API_KEY` to `GOOGLE_GENERATIVE_AI_API_KEY`).
- Adds a dependency on `@modelcontextprotocol/sdk`.
