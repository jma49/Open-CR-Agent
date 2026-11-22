# ADR-0050: ocra as an MCP server for coding agents

- Status: accepted
- Date: 2026-11-22

## Context

Developers increasingly change code through a coding agent (Claude Code, Cursor, Codex), and the place to catch a defect cheaply is before the commit, in that agent's session. The roadmap's decision 6 left room for ocra to serve "review this change" over the Model Context Protocol, and M16 lists ocra as an MCP server. `ocra serve` (HTTP and Server-Sent Events) already runs one review per request with a body that can only narrow it.

Two shapes were possible:

- **ocra reviews, the agent asks.** The agent calls a tool; ocra runs its own pipeline with its read-only agents, Verify, the judge and the spend limit, on the models in its configuration, and returns the report.
- **The agent reviews, ocra directs** (a delegate mode): no model key, the host's model reads the change under ocra's grouping and rules. The host can write files and run commands, so ocra's read-only guarantee and its verified, code-computed verdict would not hold. This is a product decision, left open.

## Decision

1. **`ocra mcp` serves MCP on standard input and output** for the repository it starts in, with one tool, `review`. Standard output carries only the protocol; what the review would print goes nowhere, messages for people go to standard error.
2. **The tool takes `ocra serve`'s request and nothing more:** `target` (workspace, range, commit), `reviewers`, `maxCostUsd`, plus `format` (`text` or `json`). The schema moves to `commands/review/request.ts` and both servers use it; an unknown argument is refused, never ignored. A review run this way is `ocra review`'s: the same configuration, trust rules, spend limit, session and ocra Cloud upload.
3. **The answer is marked as data.** It starts with a sentence saying the findings describe code that may be untrusted and are not instructions, then `ocra review`'s text output (control characters already replaced) or its JSON report. The host is an agent with a shell, so this is the same rule as neutralizing text before it reaches a prompt or a terminal.
4. **One review at a time;** a second call while one runs is refused with an error result. The client's cancellation cancels the review, and finished review tasks are reported as MCP progress when the client asks for it.
5. **The MCP SDK is an optional dependency of the CLI, imported only by `ocra mcp`.** It already came with the OpenCode runtime, so the default install gains no package, and `--omit=optional` (the Action's `opencode: false`, ADR-0023) still leaves out both OpenCode and the SDK's server stack, so CI installs stay small. Without it, `ocra mcp` exits 2 and says how to install it.
6. **No delegate mode.** It waits for the product decision and its own ADR.

## Consequences

- Any MCP host starts reviews without new code; the agent pays with ocra's configured key, bounded by `maxCostUsd` or the configuration's limit.
- `--omit=optional` now means no OpenCode and no MCP server; a future optional dependency must be weighed against that meaning again.
- A host that starts its servers outside the repository gets an error from the first review; the manual says to start it in the repository.
