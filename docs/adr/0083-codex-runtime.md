# ADR-0083: A runtime on the user's own Codex sign-in

- Status: accepted
- Date: 2026-11-24

## Context

A reviewer brings a provider key today: the `opencode` and `direct` runtimes both send each request with a key from the environment or from ocra Cloud. Many individual developers have no API key but do pay for an agent plan they already use at their desk, and they ask to review on that. Teams keep the key-based engine; the two modes are for two audiences.

Codex is the first agent: its CLI signs in with a ChatGPT account (`codex login`), runs one task non-interactively with `codex exec --json`, and takes MCP servers as tools. The review must still read the change only through ocra's tools, so that what the reviewer sees is the checkout ocra prepared, and its findings must still go through Verify and Judge like any other.

## Decision

1. **`@open-cr-agent/runtime-codex`** registers the runtime `codex`. Its chains name `codex/default` (Codex's own default model) or `codex/<model>`; a chain naming any other provider is refused before Codex starts. It is an optional dependency of the CLI, loaded only when the configuration names it (ADR-0023).
2. **One `codex exec` per attempt.** The task's system prompt replaces Codex's instructions (`model_instructions_file`), the user prompt goes on stdin, and ocra's review tools are the MCP server `ocra` on the loopback tool server, its bearer token passed by variable and its tools approved, since exec refuses what it would ask about. A plain completion is the same exec without the tool server.
3. **Codex's own tools are off.** The exec runs read-only in an empty directory, with `--ignore-user-config` and `--ignore-rules` (no MCP servers, hooks or plugins of the user's), `--ephemeral` (no session in the user's history), web search off, and every tool feature this Codex knows disabled by name, read from `codex features list`, since Codex rejects a feature it does not know. A Codex that cannot switch off its shell is refused. Should Codex use a tool of its own anyway, the attempt stops with a non-retryable error.
4. **The user's sign-in, never a key.** Codex starts with an allowlisted environment (home, Codex home, keyring, locale, proxy and CA settings); `OPENAI_API_KEY`, `CODEX_API_KEY` and the rest stay out. Before the first task the runtime checks the version (0.172.0 or later, the oldest tested), the features and `codex login status`, and says what to do when one fails.
5. **What the attempt reports comes from the JSON lines.** Findings are the arguments of completed `report_finding` calls (a call the tool refused counts as a call, not a finding); tokens come from `turn.completed`, cached input apart; cost is 0, since the user's plan pays. Codex does not report its requests, so a step is a tool call or a message. A usage limit counts as a daily quota, a sign-in error stops the chain, anything else lets the next model try.
6. **No resume and no wrap-up turn.** An ephemeral exec keeps no session to continue, so an attempt that stops early or reaches the step cap (`MAX_AGENT_STEPS` tool calls, after which the process group is stopped) ends there and its files count as partly reviewed.

## Consequences

- `"runtime": "codex"` with `"models": { "standard": ["codex/default"], "light": ["codex/default"] }` reviews on the user's ChatGPT plan, on the computer where Codex is signed in. Reviews in CI need the key-based runtimes.
- The runtime does not pass the conformance suite of ADR-0020, which speaks chat completions while Codex speaks the Responses API; an end-to-end test runs the real Codex CLI (a dev dependency) against a scripted Responses endpoint declared as a model provider through `-c` overrides, which also skips the sign-in check.
- A step cap stop loses the turn's token counts, which Codex reports only when a turn ends.
- The loopback tool server is a copy of the OpenCode runtime's, with the token handed over instead of a header. A shared package for it can come with the next agent runtime.
- Other agents (Claude Code, Cursor, OpenCode, Pi, Antigravity) follow as runtimes of their own on the same pattern; labelling the posted review with the agent, and ocra Cloud's runner for queued reviews, are separate changes.
