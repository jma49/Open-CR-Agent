# ADR-0003: OpenCode as agent runtime behind an AgentRuntime contract

- Status: accepted; tool delivery refined by [ADR-0005](0005-review-tools-over-mcp.md); second runtime: [ADR-0020](0020-direct-runtime.md); OpenCode made optional by [ADR-0023](0023-optional-opencode-runtime.md)
- Date: 2026-09-24

## Context

Reviewers need an agent loop with tool use, context compaction, sessions, streaming events and multi-provider models. Open-source options considered:

| Option | License | Language | Notes |
|---|---|---|---|
| OpenCode | MIT | TS/Bun | SDK with sessions, SSE events, JSON-schema output, plugin tools, per-tool permissions; proven at scale by Cloudflare. Default prompt and toolset target coding, not review. |
| Pi | MIT | TS | Minimal prompt and fully custom tools; weaker multi-session orchestration. |
| Codex CLI | Apache-2.0 | Rust | `codex exec` non-interactive mode; cross-language, OpenAI-centric. |
| Goose | Apache-2.0 | Rust | MCP-first, cross-language. |
| Mastra / AI SDK / LangGraph.js | mixed | TS | Frameworks; we would rebuild the agent loop ourselves. |
| Claude Agent SDK | wraps closed-source Claude Code | TS | Not fully open source, single vendor. |

## Decision

Use OpenCode (via `@opencode-ai/sdk` in server mode) to execute individual agent tasks only. Orchestration stays in our pipeline. Reviewer agents use our own system prompts, have write and shell tools disabled, and get review tools (`read_diff`, `code_search`, `report_finding`, `task_done`) registered through an OpenCode plugin.

The pipeline talks only to the `AgentRuntime` contract in `core`.

## Consequences

- Fast start with a mature runtime and many providers.
- Token overhead and API churn are the main risks; both are contained by the contract. Pi is the fallback runtime.
- Requires the OpenCode binary at run time.

## Implementation notes (2026-10-09)

The decision to run tasks on OpenCode behind `AgentRuntime` stands; two consequences no longer hold:

- The second runtime is `direct` (ADR-0020), which calls OpenAI-compatible endpoints itself, not Pi.
- The OpenCode binary is needed only when a review uses the `opencode` runtime: `runtime-opencode` is an optional dependency of the CLI (ADR-0023).
