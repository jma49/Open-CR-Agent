# ADR-0070: Tool calls as text for endpoints without function calling

- Status: accepted
- Date: 2026-11-23

## Context

A reviewer is an agent loop over tools: it reads files, searches, and reports each finding by calling `report_finding`. Both runtimes offer the tools through the chat completions protocol's `tools` parameter.

Inside a company the model is often served where that parameter does not work: vLLM started without a tool call parser answers 400 (`"auto" tool choice requires --enable-auto-tool-choice`), an Ollama model without a tool template answers 400 (`does not support tools`), and a gateway that only forwards messages drops the parameter. Tested against a scripted endpoint, the first two failed every review task with the endpoint's error, and the third ended every task as partly reviewed with no tool calls. The models behind such endpoints (Qwen, Hermes-style fine-tunes, DeepSeek) are trained to write a call as a `<tool_call>` block of JSON; the server's parser is what turns that into the protocol's tool calls.

## Decision

1. **The direct runtime can carry tool calls as text.** The tools are described in the system prompt (name, description, the JSON Schema of the arguments), the model writes each call as `<tool_call>{"name": …, "arguments": …}</tool_call>`, and the results come back in the next user message, each in an `<ocra_tool_result tool="…">` section. The protocol lives in core (`runtime/text-tools.ts`), next to the tools and the rule that data cannot form ocra's tags; the chat completions wire uses it.
2. **It is chosen two ways.** A provider declared with `"toolCalls": "text"` is sent every request that way. Otherwise a request whose tools the endpoint refuses (400 or 422 naming the tools), before the conversation holds any call, is sent once more as text, and the run remembers the model so its later tasks start that way. A refusal later in a conversation is about that conversation and goes to the failback chain.
3. **The loop does not change.** Steps, the step cap, the resume and wrap-up turns, argument validation and the review context are those of `loop.ts`; the wire converts at its boundary, as for the two protocols (ADR-0062). A block that is not a call is answered like a wrong call, and the model may correct it.
4. **A result is data.** It goes through `data()` and `section()`, so a file's content cannot close its result or open another. Only the model's own answer is parsed for calls, which gives a file no more reach than it has over a model that calls tools through the protocol.
5. **Only the chat completions wire, only the direct runtime.** Anthropic's Messages protocol always has tools. OpenCode sends tools itself and cannot be told otherwise, so its configuration refuses a provider declared `text` and names the direct runtime.

## Consequences

- A team whose internal endpoint takes no tools can run reviews without changing the server. Quality then depends on how well the model keeps to the form, which the server's own parser, where it can be turned on, does better.
- An endpoint that drops the parameter silently cannot be detected; it needs the declaration. The manual says how such a run looks.
- The prompt differs from the measured one only on endpoints that could not review before; nothing changes for an endpoint that takes tools. Not evaluated on the golden set, and not run against a live model yet.
- The first requests a run sends such a model each get one refusal before the run remembers it; a refusal costs no tokens.
