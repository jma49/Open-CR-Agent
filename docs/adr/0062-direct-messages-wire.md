# ADR-0062: The direct runtime speaks Anthropic's Messages protocol

- Status: accepted
- Date: 2026-11-23

## Context

The direct runtime (ADR-0020) reached only endpoints that speak OpenAI's chat completions. Anthropic's own API speaks Messages, and so do the endpoints some providers offer for their coding models. A review through ocra Cloud with a key for such a provider could not run at all: the gateway (ADR-0024) forwards the provider's paths as they are, and the CLI declared a gateway provider only by a chat completions path.

Anthropic also serves a chat completions path that translates to Messages. It leaves out what a review needs most from that API: the prompt cache, which an agent's steps read at a tenth of the input price, and the model's reasoning between tool calls.

## Decision

1. **A declared provider names its protocol.** `providers.<id>.type` in `.ocra/config.json` is `openai-compatible` or `anthropic` (`CustomProvider.api`, default `openai`). An `anthropic` provider's `baseUrl` is the address `/v1/messages` sits under, and `effort` (how a chat completions endpoint spells the effort) does not apply to it.
2. **The agent loop is written once, over a wire** (`runtime-direct/src/wire.ts`): a `Dialogue` takes what is said, asks the endpoint, and takes the tools' outputs. Each protocol keeps the conversation in its own messages (`openai.ts`, `anthropic.ts`) and converts at that boundary; steps, the resume turn, the wrap-up turn, timeouts and failback stay in `loop.ts` and the chain runner, the same for both.
3. **Messages go through Anthropic's SDK**, streamed, with no retries of its own (the wire sends a transient failure once more, as the other does). The client is always given the provider's key, or an empty one with the header removed, so the SDK never looks for a credential in the environment or on disk.
4. **The prompt cache is used at every step.** The system prompt carries a cache mark, and so does the last block of the conversation at each request, so a step reads what the step before stored. Cost counts fresh input, stored input (a quarter above the input price) and cached input (`cachedInput`) apart.
5. **Effort maps to `output_config.effort`** with adaptive thinking: `minimal` and `none` go as `low`, the lowest level the API has, `none` without asking for thinking. A model or endpoint that refuses the parameters gets the request again without them, as on the other wire. The API takes no seed and its newer models no temperature, so neither is sent; the run reports them as not applied.
6. **An answer that cannot be used fails the step**: a refusal, an answer cut off at the output cap (a cut tool call would run on half its input) or a conversation past the context window goes to the failback chain.
7. **The CLI declares a gateway provider by chat completions where ocra Cloud lists them, else by Messages.** The gateway token goes as the SDK sends a key, in `Authorization`.
8. **The OpenCode runtime refuses a declared `anthropic` provider** and names the direct runtime. It reaches Anthropic through its catalog; a declared one would need a client it does not bundle for declared providers.

## Consequences

- A team with only an Anthropic key, or an internal gateway in that protocol, runs reviews on the direct runtime with nothing else on the network; ocra Cloud can offer such providers for review models.
- `@open-cr-agent/runtime-direct` depends on `@anthropic-ai/sdk`. It sends its own client headers (version, platform) to the declared endpoint, which the hand-written chat completions client does not.
- Recordings (`OCRA_RECORD_DIR`) hold a Messages exchange as the event stream the endpoint sent, and tell requests apart by the system prompt too, which that protocol keeps outside the messages.
- The quality numbers were measured on `opencode`; this wire passes the runtime's own tests against a scripted endpoint and has not been evaluated on the golden set.
