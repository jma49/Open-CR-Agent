# Spike 0001: OpenCode as the review runtime

- Issue: #2
- Date: 2026-09-24
- OpenCode 1.18.32 (`opencode-ai`, `@opencode-ai/sdk`, `@opencode-ai/plugin`), Google Gemini via `@ai-sdk/google`
- Input: one file, one hunk, five added lines with a planted off-by-one bug; real `correctnessReviewer` prompt and rules from `@open-cr-agent/core`
- Total model spend for the spike: about $0.05

## Setup that worked

- `createOpencodeServer({ config })` starts `opencode serve` from `PATH` and passes the config through `OPENCODE_CONFIG_CONTENT`.
- A custom primary agent (`agent["ocra-reviewer"]`) with `prompt` set to our system prompt. The first request carried about 2.4k input tokens, so OpenCode's own coding prompt is replaced, not appended.
- Every built-in tool disabled through the agent's and the prompt's `tools` map (`bash`, `edit`, `write`, `apply_patch`, `read`, `glob`, `grep`, `task`, `webfetch`, `websearch`, `todowrite`, `skill`, `question`, …), plus `permission` deny for edit, bash and webfetch.
- Review tools served over MCP from our own process: an HTTP server bound to `127.0.0.1`, protected by a random bearer token, registered as `mcp.ocra = { type: "remote", url, headers }`. OpenCode exposes them as `ocra_<tool>`.

## Results

| Run | Model | Tools | Outcome | Steps | Input / output / reasoning tokens | Cost | Time |
|---|---|---|---|---|---|---|---|
| 1 | gemini-3.8-flash | built-in read-only | 503 "high demand", then an empty stream and a 400 | 2 | 2.4k / 0 / 0 | $0.002 | 122 s |
| 2 | gemini-3.7-flash | built-in read-only | Found the bug, plus an unplanted edge case (`n >= length` gives a negative index); reported as plain text because `report_finding` was not registered | 5 | 17.8k / 0.4k / 2.6k | $0.025 | ~60 s |
| 3 | gemini-3.7-flash | MCP | 503 before the first response | 1 | 0 | $0 | 75 s |
| 4, 5 | gemini-3.5-flash | MCP | Called `read_file`, `code_search`; 503 mid-run | 2–4 | 6.4k / 0.1k / 0.7k | $0.016 | 84 s |
| 6 | gemini-flash-lite-latest | MCP | `read_file` → `report_finding` (correct defect and fix) → `task_done` | 4 | 8.0k / 0.3k / 0 | $0.003 | 4.9 s |

## Findings

1. **System prompt and tool isolation work.** Our prompt replaces OpenCode's, and built-in tools can be disabled completely; the model never called a shell or write tool.
2. **Plugins listed in the `plugin` config are not loaded** in this version. Plugins load only from a `plugins/` directory: the project's `.opencode/plugins/` (which would write into the reviewed repository) or `$OPENCODE_CONFIG_DIR/plugins/` (a directory we own, verified).
3. **MCP delivers our tools with less overhead.** Tool calls reach our process directly, so they can use `ReviewContext` (the reviewed revision, not the working tree) and findings arrive as structured arguments without reading session messages back. The purpose-built tools also used fewer tokens than OpenCode's built-ins for the same investigation.
4. **OpenCode's Google provider reads only `GOOGLE_GENERATIVE_AI_API_KEY`**, although models.dev also lists `GOOGLE_API_KEY` and `GEMINI_API_KEY`. The runtime must map the key when it starts the server.
5. **Provider overload is the dominant failure.** Three Flash generations returned 503 during the spike. OpenCode retries internally about four times with backoff and then fails the turn; one retry path ended in a 400 ("Requests ending with a model turn are not supported"). A model failback list is required from the first real release, not in M4.
6. **Reasoning tokens matter.** Run 2 spent more reasoning than output tokens; per-tier reasoning settings belong in the model configuration.

## Consequences

Recorded in [ADR-0005](../adr/0005-review-tools-over-mcp.md). Implementation continues in #8.
