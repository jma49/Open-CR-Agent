---
"@open-cr-agent/cli": minor
---

### Added

- `ocra init` writes `.ocra/config.json` for the model key in the environment (Gemini, Anthropic and OpenAI on the default OpenCode runtime, OpenRouter's free model on the direct runtime), and with `--github` the fork-safe GitHub workflow (`--same-repo-only` for the plain `pull_request` one); a file that exists is kept unless `--force` is given.
