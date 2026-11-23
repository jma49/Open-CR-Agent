---
"@open-cr-agent/core": minor
"@open-cr-agent/cloud-contract": minor
"@open-cr-agent/runtime-direct": minor
"@open-cr-agent/runtime-opencode": patch
"@open-cr-agent/cli": minor
---

### Added

- The `direct` runtime reviews on a chat completions endpoint that takes no `tools` parameter (vLLM without a tool call parser, an Ollama model without a tool template): when the endpoint refuses the tools, the request goes again with the tools in the system prompt and the model's `<tool_call>` blocks run as calls. `providers.<id>.toolCalls: "text"` sends every request that way, for a gateway that drops the parameter silently.
- `textToolInstructions`, `parseTextToolCalls` and `textToolResults` in `@open-cr-agent/core`, and `CustomProvider.toolCalls`, for runtime plugins.
