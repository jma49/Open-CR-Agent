# Open-CR-Agent

**ocra** is an open-source code review engine. Deterministic code decides what to review, how to split it, which rules apply and where a comment lands; isolated LLM agents make only the judgment calls, and everything they say is fact-checked, deduplicated and anchored before anyone reads it.

It reviews local changes, GitHub pull requests and GitLab merge requests, runs inside your CI with your own model keys, and is built to be run on pull requests you do not trust.

[![npm](https://img.shields.io/npm/v/@open-cr-agent/cli?label=npm)](https://www.npmjs.com/package/@open-cr-agent/cli)
[![CI](https://github.com/jma49/Open-CR-Agent/actions/workflows/ci.yml/badge.svg)](https://github.com/jma49/Open-CR-Agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

> **Status:** early 0.x. The CLI flags, configuration keys, exit codes and report format are [contracts](docs/manual/en/stability.mdx) and change only with notice; prompts and review quality still move. [Measured quality](docs/manual/en/quality.mdx) says what reviews find and miss today, on a small sample. Manual: [ocracloud.com](https://ocracloud.com) ([English](docs/manual/en/index.mdx) · [中文](docs/manual/zh/index.mdx)).

## Why ocra

Most review bots are `diff → model → comment`. ocra puts code around the model at every step where a mistake would be expensive:

- **Code decides what the model sees.** File selection, risk tiering, bundling, rule matching and the reviewer matrix are pure functions with tests. Secret-looking paths and `.git/` are refused in one place, for every agent and every tool.
- **Every finding is anchored by the code it quotes, never by a line number the model made up.** Quotes are matched in the diff, then the file, then other files' hunks; an ambiguous quote becomes a file-level comment, counted in the report.
- **Findings are fact-checked and judged before they are posted.** A verifier drops what the diff proves wrong and marks the rest confirmed or uncertain; a judge deduplicates across reviewers and calibrates severity. The verdict is computed by code from the judged findings.
- **Re-reviews are incremental and evidence-based.** A finding is called fixed only when the code it pointed at is gone; a maintainer's dismissal silences it; the pull request's own author cannot.
- **Cost is bounded and reported.** A per-run spend limit stops starting tasks, the report names the files it left unreviewed, and the next review continues with them. Tokens and dollars are reported for every model call.
- **Untrusted pull requests are the design case.** Agents get read-only tools, no shell and no web; configuration, rules and memory are read from the base commit; model text cannot form links, mentions or commands in a comment. See the [threat model](docs/manual/en/threat-model.mdx).
- **Structured output.** A versioned JSON report with a published [JSON Schema](docs/schema/report.v1.json), every finding saying which task and model produced it, [SARIF 2.1.0](docs/manual/en/github.mdx) out for code scanning and in from Semgrep, CodeQL and other analyzers, and a session log with cost, tokens and latency per run.

## How it works

```
 Ingest → Select → Triage → Bundle → Matrix → Execute → Anchor → Filter → Verify → Judge → Publish
 └─────────── deterministic ─────────────┘   └─ LLM ─┘  └ code ┘  └ code ┘  └ LLM ┘  └ LLM ┘  └ code ┘
```

Five reviewers ship today, each a plugin with its own scope and model tier: `correctness`, `security`, `performance`, `docs` and `agents-md`. Reviewers run as isolated agent tasks, one per (bundle, reviewer) cell, and submit findings through a typed tool, never as free text. Models fail over along a chain with a circuit breaker per model; a failed task becomes a coverage gap in the report, not a failed run.

The full design: [architecture](docs/architecture.md) and the [decision records](docs/adr/).

## Quickstart

Requires Node.js 22.19 or newer and Git.

**Five-minute setup.** With a model key in your shell, `ocra init` writes the configuration:

```bash
npm install -g @open-cr-agent/cli
export GEMINI_API_KEY="your-key"     # or ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY
cd your-repository
ocra init                            # .ocra/config.json with models for that key
ocra review                          # review your uncommitted changes
ocra init --github                   # also .github/workflows/ocra.yml, safe for pull requests from forks
```

`ocra init` never replaces a file that exists (`--force` does), and prints the next steps, such as the `gh secret set` and `gh label create ocra-review` commands for the workflow ([ocra init](docs/manual/en/cli.mdx#ocra-init)). Or set it up by hand:

```bash
npm install -g @open-cr-agent/cli
export GEMINI_API_KEY="your-key"       # any provider OpenCode supports; see Model providers
ocra review --from main                # this branch since it diverged from main
```

Pick models in `.ocra/config.json` of the repository you review (or with `OCRA_MODEL_TOP`, `OCRA_MODEL_STANDARD` and `OCRA_MODEL_LIGHT`; a list is a failback chain):

```json
{
  "models": {
    "top": "google/gemini-3.1-pro-preview",
    "standard": ["google/gemini-3.5-flash", "google/gemini-flash-lite-latest"],
    "light": "google/gemini-flash-lite-latest"
  }
}
```

`standard` models review code, `light` models do helper work such as grouping files, and the `top` model judges. More targets:

```bash
ocra review                                  # uncommitted changes, including untracked files
ocra review --commit abc123                  # a single commit
ocra review --plan                           # files, bundles, tasks, prompt sizes, input cost; no model call
ocra review --max-cost-usd 2                 # a spend limit; the report says what it left
ocra review --format sarif --output out.sarif
ocra review --import-sarif semgrep.sarif        # an analyzer's results on the change join the review
ocra review --pr 42 --publish                # a GitHub pull request, posted as a review
ocra review --mr 7 --publish                 # a GitLab merge request
```

Without installing: `npx @open-cr-agent/cli review`. OpenCode, the default runtime, is an optional dependency; with the `direct` runtime you can install without it, 11 MB instead of 175 MB ([Installation](docs/manual/en/installation.mdx#without-opencode)). The [quickstart](docs/manual/en/quickstart.mdx) walks through a first run; [Model providers](docs/manual/en/providers.mdx) covers every provider, including your own OpenAI-compatible endpoint with a price per model.

## In CI

**GitHub pull requests**, with the Action in [`action.yml`](action.yml): inline comments, one summary comment that is updated in place, and re-reviews of only what changed since the last push.

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

Pin the Action by commit, as here: a tag can be moved. Its outputs (`verdict`, `exit-code`, `run-id`, `findings`, `report`, and `sarif` with `sarif: true`) feed later steps, such as uploading SARIF to code scanning. The Action installs the published CLI only when every package carries provenance from this repository's release workflow; otherwise it builds from source and says so. With `"runtime": "direct"` in the configuration, `opencode: false` skips installing OpenCode. Pull requests from forks need the gated `pull_request_target` setup in the [GitHub guide](docs/manual/en/github.mdx).

**GitLab merge requests**, on GitLab.com or self-managed, from a CI job: see the [GitLab guide](docs/manual/en/gitlab.mdx).

**Any other runner**, with the container image `ghcr.io/jma49/ocra:<version>` (amd64 and arm64, attested provenance, SBOM): see [Installation](docs/manual/en/installation.mdx).

## Outputs and exit codes

Each run writes `events.jsonl` and `report.json` under `.ocra/sessions/`. `--format json` prints the report; `--format sarif` prints SARIF 2.1.0 for code scanning dashboards.

| Exit code | Meaning |
|---|---|
| `0` | Review finished |
| `1` | A critical finding the verifier confirmed (verdict `significant_concerns`) |
| `2` | Usage error, or no review task completed |
| `3` | Review incomplete: some files were not reviewed (a failed task, a spend limit) |
| `130` | Interrupted |

CI must never read an incomplete review as a pass; that is what `3` is for. The verdict is advice from models that read the change, which can be swayed by text in it: do not use it as a security gate.

## Configuration

`.ocra/config.json` in the reviewed repository, read from the base commit on pull requests:

```json
{
  "models": { "top": "...", "standard": ["..."], "light": "..." },
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

Repository guidelines come from `AGENTS.md`; path-scoped review rules from `.ocra/rules.json`:

```json
{ "rules": [{ "path": "api/**", "rule": "Handlers must check tenant ownership." }] }
```

A team can also share configuration over https (`extends`), `ocra review --config <file>` reads a file of your own instead of the repository's (also under `--no-repo-config`), `ocra memory` records the findings a team accepts so they are not reported again, and `ocra metrics` counts runs, cost, findings and what became of them over the session reports. `ocra login`, `ocra logout` and `ocra whoami` sign in to ocra Cloud (https://app.ocracloud.com, in development) ([CLI](docs/manual/en/cli.mdx#ocra-login-ocra-logout-ocra-whoami)). While signed in, your account's models, limits, file patterns and rules apply under the repository's configuration, never in place of it, and never providers or plugins ([Account settings](docs/manual/en/configuration.mdx#account-settings)). Findings remembered from the web join `.ocra/memory.json`'s, and the report names which memory hid each one; findings go to ocra Cloud only when the account turns that on, with secret-looking tokens redacted first ([CLI](docs/manual/en/cli.mdx#memory-in-your-ocra-cloud-account)). Every key: [Configuration](docs/manual/en/configuration.mdx), [Rules](docs/manual/en/rules.mdx).

## Extending ocra

ocra is built as an engine with contracts for the parts that vary. The parts that ship are plugins against the same contracts anyone can implement:

| Contract | What it does | Shipped implementations |
|---|---|---|
| `VcsAdapter` | Where a change comes from and where the review goes | local git, GitHub, GitLab |
| `AgentRuntime` | How one isolated review task runs | OpenCode; `direct`, a tool loop over your declared endpoints |
| Reviewer | Who reviews what, at which model tier | `correctness`, `security`, `performance`, `docs`, `agents-md` |
| Rules and tools | Path-scoped instructions; read-only tools an agent may call | `.ocra/rules.json`; `read_file`, `read_diff`, `code_search`, `report_finding` |
| Analyzers | Findings from tools that are not a model, as the SARIF 2.1.0 log a CI job hands over (`--import-sarif`); ocra runs no tool | tested with Semgrep's output |

A plugin is a module with a name and lifecycle hooks:

```js
export default {
  name: "acme-rules",
  configure(ctx) {
    ctx.registerRules([{ path: "services/**", rule: `Owned by ${ctx.settings.team}: check idempotency keys.` }]);
  },
};
```

Plugins run code, so they load only when the reviewed tree is trusted: in local reviews, never on pull requests or under `--no-repo-config`. Plugins your ocra Cloud account names load only after `ocra plugins allow <name>@<version>` installed that exact version on the machine, scripts off, and only from there. The platform-neutral rules of the review conversation (who may dismiss, what counts as fixed, how the summary reads) live once in `vcs-platform`, with a conformance suite every platform adapter runs. [Plugins guide](docs/manual/en/plugins.mdx), [plugin contract](docs/adr/0006-plugin-contract.md).

ocra is a library first: `review()` from `@open-cr-agent/core` runs the same pipeline the command runs, from your own program, bot or service, with the plugins you choose. Its errors carry a stable code (`OcraError`). Each package exports a curated public API, recorded in [`etc/`](etc/) and checked in CI; [Embedding ocra](docs/manual/en/embedding.mdx) is the contract page.

## Security model

Assume the reviewed code is hostile; ocra does.

- Agents have read-only tools, no shell, no web, and an environment allowlist. Secret-looking paths and `.git/` are refused in core, once, for every adapter.
- On pull requests nothing from the reviewed tree runs: no plugin, no OpenCode configuration, no install script, no diff driver. Configuration, rules and memory come from the base commit.
- Every untrusted string in a prompt is fenced; model text in a comment cannot form a link, a mention, a quick action or a command. Commands are accepted only from unedited comments by people with write access.
- Releases use trusted publishing with SLSA provenance; the Action requires it. No code is fetched from a registry at review time, and with the `direct` runtime nothing but your model endpoint is reached. The container image is attested.
- An adversarial golden tier plants instructions, links and commands in reviewed changes and measures what gets through.

[Security](docs/manual/en/security.mdx), [threat model](docs/manual/en/threat-model.mdx), [SECURITY.md](SECURITY.md) for private reporting.

## Quality and evaluation

Numbers are published with their limits, and only numbers that were measured. Today: one run on 16 golden cases, with recall the weak point, on one model family; a second model spot-checked the labels. Two identical runs on ten benchmark pull requests differ by 20 points of precision, so the sample cannot yet decide prompt changes, and prompts stay frozen until it can. [Measured quality](docs/manual/en/quality.mdx).

`ocra-eval` replays [AACR-Bench](https://github.com/alibaba/aacr-bench) (200 real pull requests, 1,505 expert-verified comments) and ocra's own golden set, and reports precision, recall, F1, cost and latency. Reviews run at a fixed temperature and seed, every report records the ocra version, prompt and configuration hashes and the sampling applied, and `--repeat k` gives each metric a 95% confidence interval, so `compare` calls a change better only when the intervals separate. The free `ceiling` command shows what the deterministic stages can reach at all. [Evaluation guide](docs/manual/en/evaluation.mdx).

## Where it is going

ocra's long-term position is the engine other review agents are built on, not another bot: one shared `Finding` model, stable contracts for the parts that vary, and a conformance suite for every pluggable part. The reference reviewer stays the product and the engine's first customer, and contracts are extracted when a second real implementation needs them, never ahead of that.

| Milestone | Scope | State |
|---|---|---|
| M1–M4 | Pipeline, reviewers, GitHub, incremental re-review, failover, memory | built |
| M7–M9 | On npm with provenance; untrusted-PR hardening; GitLab, SARIF, container image, declared providers (0.2.0) | built |
| M5–M6 | A quality number that can decide changes; recall without losing precision | paused until model credit |
| M10 | Contracts: a Finding specification, a public `review()` entry, a second runtime with a conformance suite, SARIF in | mostly built; the rest paused |
| M14 | ocra Cloud ([ADR-0024](docs/adr/0024-ocra-cloud.md)): login, your own key behind a model gateway, a web view of reviews, account configuration and opt-in findings | Phase 1 built (0.5.0); frozen while users and recall come first |
| M11–M13 | Evidence (a nightly live test, per-reviewer numbers), operability (organization policy, run ids, metrics), external use | now: external use and recall (M11, M13), with `ocra init` for a one-command setup; operability paused |

The plan, the reasoning and what is deliberately not built: [roadmap](docs/roadmap.md).

## Packages

To use ocra you install one package, `@open-cr-agent/cli`; it brings the others it needs. The rest are listed for people who embed the engine or build on its contracts.

| Package | Responsibility |
|---|---|
| `@open-cr-agent/core` | Domain types, pipeline stages, `VcsAdapter` / `AgentRuntime` / plugin contracts; depends on nothing in the repo |
| `@open-cr-agent/runtime-opencode` | `AgentRuntime` on the OpenCode SDK |
| `@open-cr-agent/runtime-direct` | `AgentRuntime` that calls declared OpenAI-compatible endpoints itself; nothing else on the network |
| `@open-cr-agent/vcs-platform` | The review conversation every platform shares: trust rules, state, summary and comment text |
| `@open-cr-agent/vcs-github` | `VcsAdapter` for GitHub pull requests |
| `@open-cr-agent/vcs-gitlab` | `VcsAdapter` for GitLab merge requests |
| `@open-cr-agent/vcs-local` | `VcsAdapter` for the local git repository |
| `@open-cr-agent/cloud-contract` | The wire contract with ocra Cloud (Zod schemas, limits, vocabularies, error codes, the redaction pass); installed with the CLI, not used directly |
| `@open-cr-agent/cli` | The `ocra` command |
| `@open-cr-agent/eval` | Benchmark replay and quality metrics |

## Development

```bash
git clone https://github.com/jma49/Open-CR-Agent.git
cd Open-CR-Agent && npm install && npm run build
npm link --workspace @open-cr-agent/cli   # ocra from this checkout
npm run verify                            # Biome, type check and tests (no model, no network)
```

Rules for humans and agents, the same ones CI enforces: [AGENTS.md](AGENTS.md). Releases: [CHANGELOG.md](CHANGELOG.md); a change users see adds a changeset ([.changeset/README.md](.changeset/README.md)).

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md): what helps most, setup, and what is frozen until there is credit to measure it.
- [SECURITY.md](SECURITY.md): report vulnerabilities privately, never in a public issue.
- [Stability and support](docs/manual/en/stability.mdx): what counts as a contract, how it may change, and how to verify a release.
- [Code of conduct](CODE_OF_CONDUCT.md).

Inspired by [Cloudflare's AI code review](https://blog.cloudflare.com/ai-code-review/) and [Alibaba OpenCodeReview](https://github.com/alibaba/open-code-review).

## License

[Apache-2.0](LICENSE)
