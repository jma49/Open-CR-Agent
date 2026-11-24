# @open-cr-agent/runtime-codex

The Codex agent runtime of [Open-CR-Agent](https://github.com/ocrahq/Open-CR-Agent), the multi-agent code reviewer: each reviewer runs as one `codex exec` on the [Codex CLI](https://github.com/openai/codex) signed in on your computer, so a review uses your own ChatGPT plan instead of an API key. Most users want [`@open-cr-agent/cli`](https://www.npmjs.com/package/@open-cr-agent/cli) (the `ocra` command) and the [manual](https://ocracloud.com). All packages share one version. Apache-2.0.

```json
{
  "runtime": "codex",
  "models": { "standard": ["codex/default"], "light": ["codex/default"] }
}
```

Needs Codex 0.172.0 or later, signed in with `codex login`, found as `codex` on `PATH` or at `OCRA_CODEX_BIN`. See ADR-0083 for what the reviewer can and cannot reach.
