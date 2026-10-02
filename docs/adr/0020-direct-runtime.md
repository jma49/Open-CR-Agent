# ADR-0020: A second runtime, the direct tool loop, and the runtime conformance suite

- Status: accepted
- Date: 2026-10-02

## Context

Every review so far ran through OpenCode (ADR-0003). The roadmap's M10 asks for a second `AgentRuntime` for two reasons: the contract is only a contract once two implementations keep it, and OpenCode brings things to review time that a review does not need, a pricing-catalog fetch from `models.opencode.ai` and an attempted npm install of its plugin package, both documented on the security page and both refused by configuration rather than absent.

Declared providers (ADR-0017) made the second runtime small: they speak the OpenAI chat completions API, the one protocol with tool calling that every self-hosted server and gateway offers. The free-model evaluation of 2026-10-02 ran that way through OpenCode.

Decided with Claude Fable 5.1.

## Decision

1. **`@open-cr-agent/runtime-direct`** registers the runtime `direct`: a tool loop over `POST <baseUrl>/chat/completions` with the review tools as function tools, run in process against the `ReviewContext`. It reaches only providers declared in configuration; a model of any other provider, an unpriced model or a missing key variable is refused before the first request, with the OpenCode runtime named for the rest. No process, no catalog, no install, nothing on disk.
2. **The loop keeps OpenCode's semantics** so that the two runtimes measure alike: the same step cap (`MAX_AGENT_STEPS`), the same resume message once for an agent that stops silently, the same failback over the chain with the circuit breaker and quota waits, usage per step and cost from the declared price. A wrong tool call is answered with the error and the attempt goes on.
3. **What is not OpenCode's moved to core** (`core/src/runtime/`): the failback with live usage, the completion failback, the quota parsing, the model health, the review tools, the step cap and the resume message, and the attempt outcome both runtimes produce. The OpenCode runtime keeps the session, the server, the MCP tool server and the environment allowlist.
4. **A conformance suite** (`core/src/runtime/conformance.fakes.ts`) runs every runtime against a scripted OpenAI-compatible endpoint on this machine and asserts the contract: the review tools are offered and run through the context, a finding, its usage and the end are reported, a credential error stops at once, a daily quota moves to the next model, the key appears in no event, a cancelled task neither finishes nor fails, and a completion is answered and priced. The OpenCode runtime passes it with the real binary; the direct runtime with none.
5. **The key never leaves an error message.** An endpoint may echo request headers in an error page. The direct runtime keeps an excerpt with the key replaced; the OpenCode runtime replaces every configured provider credential in the error a provider returns before it becomes a progress line or a session entry. The conformance suite found the OpenCode case on its first run.

## Consequences

- A review on a declared endpoint can run with `"runtime": "direct"` and nothing else on the network. The security page says what each runtime reaches.
- The direct runtime cannot use OpenCode's catalog providers (Gemini, Vertex, Anthropic, Bedrock, …); that stays the OpenCode runtime's job until a provider SDK is worth its own code.
- Node's `fetch` ignores the proxy variables, so the direct runtime and `ocra-eval`'s judge and dataset download go through undici's proxy agent whenever `HTTP_PROXY`, `HTTPS_PROXY` or their lowercase forms are set, honoring `NO_PROXY`; without them Node's fetch is used as it is. The OpenCode runtime's client honors the variables itself.
- A third runtime starts from the conformance suite, not from a reading of the OpenCode runtime.
- The quality numbers were measured through OpenCode. The direct runtime has not been evaluated on the golden set yet; the first comparison is a smoke run on the same declared endpoint with both runtimes.
