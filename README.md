# Open-CR-Agent

English · [简体中文](README.zh-CN.md)

**ocra** is an open-source code review engine. Deterministic code decides what to review, how to split it, which rules apply and where a comment lands; isolated LLM agents make only the judgment calls, and everything they say is fact-checked, deduplicated and anchored before anyone reads it.

It reviews local changes, GitHub pull requests and GitLab merge requests, runs in your CI with your own model keys, and is built for pull requests you do not trust.

[![npm](https://img.shields.io/npm/v/@open-cr-agent/cli?label=npm)](https://www.npmjs.com/package/@open-cr-agent/cli)
[![CI](https://github.com/jma49/Open-CR-Agent/actions/workflows/ci.yml/badge.svg)](https://github.com/jma49/Open-CR-Agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

> **Status:** early 0.x. CLI flags, configuration keys, exit codes and the report format are [contracts](docs/manual/en/stability.mdx) and change only with notice; prompts and review quality still move ([measured quality](docs/manual/en/quality.mdx)). Manual: [ocracloud.com](https://ocracloud.com) ([English](docs/manual/en/index.mdx) · [中文](docs/manual/zh/index.mdx)).

## Why ocra

Most review bots are `diff → model → comment`. ocra puts code around the model wherever a mistake would be expensive:

- **Code decides what the model sees.** Selection, risk tiering, bundling, rule matching and the reviewer matrix are tested pure functions.
- **Findings are anchored by the code they quote,** never a model-made line number. An ambiguous quote becomes a file-level comment, counted in the report.
- **Findings are fact-checked and judged.** A verifier drops what the diff disproves; a judge deduplicates and calibrates severity; code computes the verdict.
- **Re-reviews are incremental.** A finding is fixed only when the code it pointed at is gone; a maintainer can dismiss it, the pull request's author cannot.
- **Cost is bounded.** A spend limit stops starting tasks, the report names unreviewed files, and the next review continues with them. Every model call reports tokens and dollars.
- **Untrusted pull requests are the design case.** See [Security model](#security-model).
- **Structured output.** A versioned JSON report ([schema](docs/schema/report.v1.json)), [SARIF 2.1.0](docs/manual/en/github.mdx) out for code scanning and in from Semgrep, CodeQL and other analyzers, and a session log with cost, tokens and latency.

## How it works

<!-- Diagrams: scripts/lib/diagrams.mjs, both languages; regenerate with node scripts/diagrams.mjs. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/system-en-dark.svg">
  <img alt="ocra system overview: a developer terminal, GitHub Actions, GitLab CI or ocra-eval starts the cli, which runs core (pipeline, ReviewContext, findings, spend limit); core reads and publishes through VcsAdapter packages (vcs-platform, vcs-github, vcs-gitlab, vcs-local) to the GitHub or GitLab API, and calls model providers through an AgentRuntime (runtime-direct or runtime-opencode, both with ChainRunner failback); signing in to ocra Cloud is optional" src="docs/images/system-en-light.svg">
</picture>

```
 Ingest → Select → Triage → Bundle → Matrix → Execute → Anchor → Filter → Verify → Judge → Publish
 └─────────── deterministic ─────────────┘   └─ LLM ─┘  └ code ┘  └ code ┘  └ LLM ┘  └ LLM ┘  └ code ┘
```

Each (bundle, reviewer) cell is an isolated agent task that reports findings through a typed tool. Models fail over along a chain with a per-model circuit breaker; a failed task is a coverage gap in the report, not a failed run.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/agents-en-dark.svg">
  <img alt="ocra's agents: a light-model bundler groups the change, the review matrix starts one isolated read-only agent task per bundle and reviewer (correctness, security and performance on the standard tier, docs and agents-md on the light tier), their findings are anchored by code with a light relocator, a standard-tier verifier fact-checks them per file, a top-tier judge deduplicates and calibrates them, and code computes the verdict" src="docs/images/agents-en-light.svg">
</picture>

Full design: [architecture](docs/architecture.md) and [decision records](docs/adr/).

## Quickstart

Requires Node.js 22.19+ and Git.

```bash
npm install -g @open-cr-agent/cli    # or run without installing: npx @open-cr-agent/cli review
export GEMINI_API_KEY="your-key"     # or ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY
cd your-repository
ocra init                            # .ocra/config.json with models for that key
ocra review                          # uncommitted changes, including untracked files
ocra init --github                   # also .github/workflows/ocra.yml, safe for pull requests from forks
```

`ocra init` never replaces an existing file (`--force` does) and prints the next steps, such as `gh secret set` and `gh label create ocra-review` ([ocra init](docs/manual/en/cli.mdx#ocra-init)).

Other targets and options:

```bash
ocra review --from main                      # this branch since it diverged from main
ocra review --commit abc123                  # a single commit
ocra review --plan                           # files, bundles, tasks, prompt sizes, input cost; no model call
ocra review --max-cost-usd 2                 # a spend limit; the report says what it left
ocra review --format sarif --output out.sarif
ocra review --import-sarif semgrep.sarif     # an analyzer's results on the change join the review
ocra review --pr 42 --publish                # a GitHub pull request, posted as a review
ocra review --mr 7 --publish                 # a GitLab merge request
```

The `direct` runtime installs without OpenCode, the optional default: 11 MB instead of 175 MB ([Installation](docs/manual/en/installation.mdx#without-opencode)). More: [quickstart](docs/manual/en/quickstart.mdx), [Model providers](docs/manual/en/providers.mdx) (including your own OpenAI-compatible endpoint).

## In CI

**GitHub pull requests**, with the Action in [`action.yml`](action.yml): inline comments, one summary comment updated in place, and re-reviews of only what changed since the last push.

```yaml
# .github/workflows/ocra.yml
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: ocra-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: jma49/Open-CR-Agent@82a3f1183a3177e9efa401d87eb95dea495ef619 # v0.6.0
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

Pin the Action by commit: a tag can be moved. Outputs: `verdict`, `exit-code`, `run-id`, `findings`, `report`, and `sarif` with `sarif: true`. With `"runtime": "direct"`, `opencode: false` skips installing OpenCode. Pull requests from forks need the gated `pull_request_target` setup in the [GitHub guide](docs/manual/en/github.mdx).

**GitLab merge requests** (GitLab.com or self-managed) from a CI job: [GitLab guide](docs/manual/en/gitlab.mdx). **Any other runner**: the container image `ghcr.io/jma49/ocra:<version>` (amd64 and arm64, attested provenance, SBOM), see [Installation](docs/manual/en/installation.mdx).

## Outputs and exit codes

Each run writes `events.jsonl` and `report.json` under `.ocra/sessions/`. `--format json` prints the report; `--format sarif` prints SARIF 2.1.0.

| Exit code | Meaning |
|---|---|
| `0` | Review finished |
| `1` | A critical finding the verifier confirmed (verdict `significant_concerns`) |
| `2` | Usage error, or no review task completed |
| `3` | Review incomplete: some files were not reviewed, or only partly (a failed task, a spend limit, a reviewer that ran out of steps) |
| `130` | Interrupted |

CI must never read an incomplete review (`3`) as a pass. The verdict is advice from models that text in the change can sway: do not use it as a security gate.

## Configuration

`.ocra/config.json` in the reviewed repository, read from the base commit on pull requests. `standard` models review code, `light` ones do helper work such as grouping files, `top` judges; a list is a failback chain (or set `OCRA_MODEL_TOP`, `OCRA_MODEL_STANDARD`, `OCRA_MODEL_LIGHT`):

```json
{
  "models": {
    "top": "google/gemini-3.1-pro-preview",
    "standard": ["google/gemini-3.5-flash", "google/gemini-flash-lite-latest"],
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

Repository guidelines come from `AGENTS.md`; path-scoped rules from `.ocra/rules.json`:

```json
{ "rules": [{ "path": "api/**", "rule": "Handlers must check tenant ownership." }] }
```

Also: `extends` shares configuration over https; `--config <file>` reads your own file instead of the repository's; `ocra memory` stops reporting accepted findings; `ocra metrics` summarizes runs, cost and findings. `ocra login` / `logout` / `whoami` connect ocra Cloud (in development): your [account settings](docs/manual/en/configuration.mdx#account-settings) apply under the repository's configuration, never providers or plugins, and findings are uploaded only when the account opts in, secrets redacted first ([CLI](docs/manual/en/cli.mdx#ocra-login-ocra-logout-ocra-whoami)). Every key: [Configuration](docs/manual/en/configuration.mdx), [Rules](docs/manual/en/rules.mdx).

## Extending ocra

What ships is built on the same contracts anyone can implement:

| Contract | What it does | Shipped implementations |
|---|---|---|
| `VcsAdapter` | Where a change comes from and where the review goes | local git, GitHub, GitLab |
| `AgentRuntime` | How one isolated review task runs | OpenCode; `direct`, a tool loop over your declared endpoints |
| Reviewer | Who reviews what, at which model tier | `correctness`, `security`, `performance`, `docs`, `agents-md` |
| Rules and tools | Path-scoped instructions; read-only tools an agent may call | `.ocra/rules.json`; `read_file`, `read_diff`, `code_search`, `report_finding` |
| Analyzers | Findings from non-model tools, as the SARIF 2.1.0 log a CI job hands over (`--import-sarif`); ocra runs no tool | tested with Semgrep's output |

A plugin is a module with a name and lifecycle hooks:

```js
export default {
  name: "acme-rules",
  configure(ctx) {
    ctx.registerRules([{ path: "services/**", rule: `Owned by ${ctx.settings.team}: check idempotency keys.` }]);
  },
};
```

Plugins run code, so they load only in local reviews, never on pull requests or under `--no-repo-config`; plugins named by an ocra Cloud account load only after `ocra plugins allow <name>@<version>`. [Plugins guide](docs/manual/en/plugins.mdx).

ocra is a library first: `review()` from `@open-cr-agent/core` runs the same pipeline from your own program; errors carry a stable code (`OcraError`), and each package's public API is recorded in [`etc/`](etc/) ([Embedding ocra](docs/manual/en/embedding.mdx)).

## Security model

Assume the reviewed code is hostile; ocra does.

- Agents have read-only tools, no shell, no web, and an environment allowlist. Secret-looking paths and `.git/` are refused in core, once, for every adapter.
- On pull requests nothing from the reviewed tree runs: no plugin, OpenCode configuration, install script or diff driver. Configuration, rules and memory come from the base commit.
- Every untrusted string in a prompt is fenced; model text in a comment cannot form a link, mention, quick action or command. Commands are accepted only from unedited comments by people with write access.
- Releases use trusted publishing with SLSA provenance, which the Action requires; the container image is attested. No code is fetched from a registry at review time, and with the `direct` runtime nothing but your model endpoint is reached.
- An adversarial golden tier plants instructions, links and commands in reviewed changes and measures what gets through.

[Security](docs/manual/en/security.mdx), [threat model](docs/manual/en/threat-model.mdx), [SECURITY.md](SECURITY.md) for private reporting.

## Quality and evaluation

Only measured numbers are published, with their limits. Today: one run on 16 golden cases on Gemini and two runs of the 10-case smoke tier on a free OpenRouter model, recall the weak point in all. Two identical runs on ten benchmark pull requests differ by 20 points of precision, so prompts stay frozen until the sample can decide changes. [Measured quality](docs/manual/en/quality.mdx).

`ocra-eval` replays [AACR-Bench](https://github.com/alibaba/aacr-bench) (200 real pull requests, 1,505 expert-verified comments) and ocra's golden set, reporting precision, recall, F1, cost and latency; `--repeat k` adds 95% confidence intervals, and `compare` calls a change better only when they separate. [Evaluation guide](docs/manual/en/evaluation.mdx).

## Where it is going

ocra aims to be the engine other review agents are built on: one shared `Finding` model, stable contracts with conformance suites, and the reference reviewer as its first customer.

| Milestone | Scope | State |
|---|---|---|
| M1–M4 | Pipeline, reviewers, GitHub, incremental re-review, failover, memory | built |
| M7–M9 | On npm with provenance; untrusted-PR hardening; GitLab, SARIF, container image, declared providers (0.2.0) | built |
| M5–M6 | A quality number that can decide changes; recall without losing precision | paused until model credit |
| M10 | Contracts: a Finding specification, a public `review()` entry, a second runtime with a conformance suite, SARIF in | mostly built; the rest paused |
| M14 | ocra Cloud ([ADR-0024](docs/adr/0024-ocra-cloud.md)): login, your own key behind a model gateway, a web view of reviews, account configuration and opt-in findings | Phase 1 built (0.5.0); frozen while users and recall come first |
| M11–M13 | Evidence (a nightly live test, per-reviewer numbers), operability (organization policy, run ids, metrics), external use | now: external use and recall (M11, M13), with `ocra init` for a one-command setup; operability paused |

Plan, reasoning and what is deliberately not built: [roadmap](docs/roadmap.md).

## Packages

Users install only `@open-cr-agent/cli`; the rest are for embedding:

| Package | Responsibility |
|---|---|
| `@open-cr-agent/core` | Domain types, pipeline, `VcsAdapter` / `AgentRuntime` / plugin contracts |
| `@open-cr-agent/runtime-opencode` | `AgentRuntime` on the OpenCode SDK |
| `@open-cr-agent/runtime-direct` | `AgentRuntime` over declared OpenAI-compatible endpoints |
| `@open-cr-agent/vcs-platform` | The review conversation platforms share |
| `@open-cr-agent/vcs-github` | `VcsAdapter` for GitHub pull requests |
| `@open-cr-agent/vcs-gitlab` | `VcsAdapter` for GitLab merge requests |
| `@open-cr-agent/vcs-local` | `VcsAdapter` for the local git repository |
| `@open-cr-agent/cloud-contract` | The wire contract with ocra Cloud |
| `@open-cr-agent/cli` | The `ocra` command |
| `@open-cr-agent/eval` | Benchmark replay and quality metrics |

## Development

```bash
git clone https://github.com/jma49/Open-CR-Agent.git
cd Open-CR-Agent && npm install && npm run build
npm link --workspace @open-cr-agent/cli   # ocra from this checkout
npm run verify                            # Biome, type check and tests (no model, no network)
```

Rules: [AGENTS.md](AGENTS.md). Releases: [CHANGELOG.md](CHANGELOG.md).

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md): what helps most, setup, and what is frozen until there is credit to measure it.
- [SECURITY.md](SECURITY.md): report vulnerabilities privately, never in a public issue.
- [Code of conduct](CODE_OF_CONDUCT.md).

Inspired by [Cloudflare's AI code review](https://blog.cloudflare.com/ai-code-review/) and [Alibaba OpenCodeReview](https://github.com/alibaba/open-code-review).

## License

[Apache-2.0](LICENSE)
