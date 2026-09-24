# Open-CR-Agent

An open-source multi-agent code review system. Deterministic engineering handles what must not go wrong (file selection, bundling, rule matching, comment anchoring); specialised LLM reviewers and a coordinator handle judgment.

Inspired by [Cloudflare's AI code review](https://blog.cloudflare.com/ai-code-review/) and [Alibaba OpenCodeReview](https://github.com/alibaba/open-code-review).

> Status: early development. User manual: [English](docs/manual/en/index.mdx) · [中文](docs/manual/zh/index.mdx). Contributors: [architecture](docs/architecture.md) and [decision records](docs/adr/).

## Usage

Reviews run on [OpenCode](https://opencode.ai) with models you configure. Provider keys come from the environment; for Google set `GEMINI_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`).

```bash
ocra review                           # uncommitted changes, including untracked files
ocra review --from main               # this branch since it diverged from main
ocra review --from main --to feature  # any range, diffed from the merge base
ocra review --commit abc123           # a single commit
ocra review --format json --output review.json
```

Exit codes: `0` no critical findings, `1` critical findings, `2` usage error or no review task completed. Each run records `events.jsonl` and `report.json` under `.ocra/sessions/`.

Optional `.ocra/config.json`:

```json
{
  "models": {
    "top": "google/gemini-3.1-pro-preview",
    "standard": ["google/gemini-3.8-flash", "google/gemini-3.5-flash", "google/gemini-flash-lite-latest"],
    "light": "google/gemini-flash-lite-latest"
  },
  "concurrency": 4,
  "taskTimeoutMinutes": 10,
  "runTimeoutMinutes": 25,
  "include": [],
  "exclude": ["legacy/**"],
  "runtime": "opencode",
  "plugins": ["@acme/ocra-plugin-rules", "./tools/ocra-plugin.mjs"],
  "pluginSettings": { "acme-rules": { "team": "payments" } }
}
```

Everything in ocra is a plugin: VCS adapters, agent runtimes, reviewers, rule packs, tools and event listeners. A plugin is a module exporting:

```js
export default {
  name: "acme-rules",
  configure(ctx) {
    ctx.registerRules([{ path: "services/**", rule: `Owned by ${ctx.settings.team}: check idempotency keys.` }]);
  },
};
```

A list is a failback chain: when a model is overloaded, out of quota or rejects a request, the task retries on the next one, and a model that keeps failing is skipped for the rest of the run. `OCRA_MODEL_TOP`, `OCRA_MODEL_STANDARD` and `OCRA_MODEL_LIGHT` override the models (comma-separated for a chain). The summary line reports tokens, reasoning tokens and cost. Repository guidelines come from `AGENTS.md`, and path-scoped review rules from `.ocra/rules.json`:

```json
{ "rules": [{ "path": "api/**", "rule": "Handlers must check tenant ownership." }] }
```

## Evaluation

`ocra-eval` replays the AACR-Bench benchmark and reports precision, recall, F1, cost and latency. See the [evaluation guide](docs/manual/en/evaluation.mdx).

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run typecheck
npm test
npm run check
```

Contribution rules for humans and AI agents live in [AGENTS.md](AGENTS.md).

## License

[Apache-2.0](LICENSE)
