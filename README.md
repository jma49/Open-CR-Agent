# Open-CR-Agent

An open-source multi-agent code review system. Deterministic engineering handles what must not go wrong (file selection, bundling, rule matching, comment anchoring); specialised LLM reviewers and a coordinator handle judgment.

Inspired by [Cloudflare's AI code review](https://blog.cloudflare.com/ai-code-review/) and [Alibaba OpenCodeReview](https://github.com/alibaba/open-code-review).

> Status: early development. See the [architecture](docs/architecture.md) and [decision records](docs/adr/).

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
