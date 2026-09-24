# Open-CR-Agent

An open-source multi-agent code review system. Deterministic engineering handles what must not go wrong (file selection, bundling, rule matching, comment anchoring); specialised LLM reviewers and a coordinator handle judgment.

Inspired by [Cloudflare's AI code review](https://blog.cloudflare.com/ai-code-review/) and [Alibaba OpenCodeReview](https://github.com/alibaba/open-code-review).

> Status: early development. See the [architecture](docs/architecture.md) and [decision records](docs/adr/).

## Usage

> The agent runtime is not wired up yet (#8), so reviews currently report every task as failed.

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
  "models": { "top": "provider/model", "standard": "provider/model", "light": "provider/model" },
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

`OCRA_MODEL_TOP`, `OCRA_MODEL_STANDARD` and `OCRA_MODEL_LIGHT` override the models. Repository guidelines come from `AGENTS.md`, and path-scoped review rules from `.ocra/rules.json`:

```json
{ "rules": [{ "path": "api/**", "rule": "Handlers must check tenant ownership." }] }
```

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
