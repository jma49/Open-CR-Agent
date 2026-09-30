# Spike 0002: OpenAI-compatible endpoints through OpenCode

- Date: 2026-09-30
- Question: can ocra send reviews to a self-hosted server or a company gateway that speaks the OpenAI API, through the pinned OpenCode (1.18.32), without OpenCode fetching code at review time?
- Answer: yes. What OpenCode fetches on its own at start is recorded below.

## Setup

A script started the real OpenCode binary the way `OpenCodeRuntime` does: isolated config, data and state directories, the environment from `serverEnv`, the configuration in `OPENCODE_CONFIG_CONTENT`. That configuration declared one provider:

```json
{ "provider": { "local": {
  "npm": "@ai-sdk/openai-compatible",
  "options": { "baseURL": "http://127.0.0.1:<port>/v1", "apiKey": "{env:LOCAL_API_KEY}" },
  "models": { "m1": { "name": "m1", "cost": { "input": 3, "output": 15 } } } } } }
```

A fake server on `127.0.0.1` answered `/v1/chat/completions` with a short streamed reply that reported 1,000 input and 10 output tokens. `HTTP(S)_PROXY` pointed at a local proxy that recorded and refused every request; `NO_PROXY` let `127.0.0.1` through. One session sent one prompt to `local/m1`.

## Results

- **The call worked with every other address refused.** The fake server received one request, with `Authorization: Bearer <the value of LOCAL_API_KEY>`. The prompt returned the server's text.
- **The price came from the configuration:** the message cost $0.00315, which is 1,000 × $3 plus 10 × $15, per million tokens. So the spend limit can count a declared model's use.
- **No package was installed for the provider.** The OpenAI-compatible client is bundled in the binary. Nothing appeared under the cache or data directories.
- **What OpenCode tried to fetch, with or without a declared provider** (the proxy saw both in a plain start too):
  1. its model catalog, `https://models.opencode.ai/api.json`. Refused, it logs "Failed to fetch models.dev" and uses the catalog bundled in the binary. `OPENCODE_DISABLE_MODELS_FETCH=1` stops the request;
  2. `@opencode-ai/plugin` from `registry.npmjs.org`, pinned to OpenCode's own version, installed in the background into each config directory. There it serves config-directory plugins, which ocra never has. No flag turns it off (the minified source calls it for every config directory). `OPENCODE_DISABLE_DEFAULT_PLUGINS` does not stop it. Refused, it logs a warning and nothing else changes.

## Consequences

- ocra can declare OpenAI-compatible providers in configuration (ADR-0017), and the review needs no network beyond the endpoint. `packages/runtime-opencode/src/custom-provider.test.ts` repeats this in CI against the real binary: every other address refused, key and price checked.
- Every ocra run let OpenCode fetch its model catalog and try to install its own plugin package from npm. Nothing ran from that package, and the version was fixed, but it was network access at review time that ocra's security page did not mention.
- Follow-up: with `npm_config_registry` or `NPM_CONFIG_REGISTRY` set to a closed port on loopback, the install sends nothing off the machine (`BUN_CONFIG_REGISTRY` does not work). ocra now sets both for OpenCode, which installs through `@npmcli/arborist` and reads npm's settings from the environment. Decided with Claude Fable 5.1.
- The same installer fetches the SDK of a provider OpenCode does not bundle, the first time a model uses it. OpenCode 1.18.32 bundles every provider the manual lists; 7 of the catalog's 225 providers need a download (2026-09-29). With the registry closed and npm's default two retries, such a model failed after 71 s; with `npm_config_fetch_retries=0`, which ocra also sets, after 0.9 s. The manual lists these providers.
- The first version of the test was vacuous under the full suite: with the setting removed it still passed, because the other real-binary tests had just installed the package through npm's shared cache (`~/.npm`, which keeps a registry answer for 300 s), so the install never reached the proxy. `custom-provider.test.ts` now gives OpenCode empty caches (`npm_config_cache` and `XDG_CACHE_HOME`, through `OCRA_RUNTIME_ENV`), requires the catalog request at the proxy, and allows nothing else. With the setting removed it fails under the full suite (the proxy sees `registry.npmjs.org:443`), and `server-env.test.ts` pins the setting itself.
