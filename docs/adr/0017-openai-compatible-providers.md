# ADR-0017: Model providers declared in configuration, OpenAI-compatible only

- Status: accepted
- Date: 2026-09-30

## Context

Teams that cannot send code to a public model API run their own: a vLLM or Ollama server, or a company gateway in front of several models. That is the data-residency case behind the roadmap's second positioning hypothesis (self-hosted, domestic models). ocra reached only the providers in OpenCode's catalog, through their environment variables. Its isolation of OpenCode (no user or project configuration) left no way to name another endpoint.

OpenCode can reach any endpoint that speaks the OpenAI API through a `provider` entry in its configuration. Spike 0002 ran the pinned binary against a local fake endpoint with every other address refused:
- the call worked with the key taken from the environment;
- the price came from the configuration;
- nothing was installed for the provider, because the client is bundled.

Decided with Claude Fable 5.1, gated by that spike.

## Decision

1. **`.ocra/config.json` may declare providers** under `providers`, by an id of the user's choice (`[a-z][a-z0-9-]*`). Model chains then name them like any other (`gateway/qwen3-coder`). One kind only: `"type": "openai-compatible"`.
2. **The endpoint**, `baseUrl`, must be `https`, or plain `http` on this machine (`localhost`, `127.x.x.x`, `::1`): it is where review code goes.
3. **The key stays in the environment.** `apiKeyEnv` names the variable, and ocra passes OpenCode `{env:NAME}` rather than the value. Only that variable reaches the runtime, not every variable with the provider's prefix. A name that looks like a platform token (`GITHUB_`, `GITLAB_`, `CI_`, `ACTIONS_`, `RUNNER_`, `NPM_`, `SSH_`, `OCRA_`) is refused, so a configuration cannot send such a token to an endpoint. Without the variable set, the run stops and names it.
4. **Every model has a price**: input and output, optionally cached input, in US dollars per million tokens. That price lets reported cost and `--max-cost-usd` count the model's use. A price of 0 is allowed, for a server of your own, and the run warns that the model is unpriced.
5. **Where providers come from:** the configuration ocra already trusts. In pull and merge requests that is the base commit, or a shared file named by `extends` (https, optionally pinned), which may declare providers too. `--no-repo-config` has none.

## Consequences

- Self-hosted and gateway models work, and CI checks them against the real OpenCode binary and a fake endpoint, with no model spend.
- Live-tested remains Gemini on Vertex and the Gemini API; declared providers are "tested against a fake server" in the manual until someone runs one live.
- A declared id that OpenCode's catalog also knows replaces that provider for the run. The manual tells users to pick an id of their own.
- Spike 0002 also found that every run lets OpenCode fetch its model catalog and try to install its plugin package from npm. The security page now says so. Whether ocra should block that install is a separate decision.

## Implementation notes (2026-10-09)

- The refused key-variable prefixes also include `GH_`, `AWS_` and `AZURE_`, so a configuration cannot send a GitHub CLI or cloud credential to an endpoint either (`packages/cli/src/config/schema.ts`).
