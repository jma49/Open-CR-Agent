# Changelog

All notable changes to the `@open-cr-agent/*` packages and the GitHub Action. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages, released together at one version, follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While that version is 0.x, a minor release may change options, configuration and output; each such change is listed here.

Entries come from the changesets in `.changeset/`, one per pull request that changes what users see; [.changeset/README.md](.changeset/README.md) says how to write one.

## [Unreleased]

### Added

- `"runtime": "direct"` reviews through the endpoints declared under `providers` without OpenCode: an OpenAI chat completions tool loop with the same step cap, failback and prices, and no other network access ([ADR-0020](https://github.com/jma49/Open-CR-Agent/blob/main/docs/adr/0020-direct-runtime.md)).
- New package `@open-cr-agent/runtime-direct`. It refuses models of undeclared providers; those stay with `opencode`, the default runtime.
- The runtime conformance suite in `core` runs against both runtimes.
- Findings carry `provenance` (the reporting `task` and, when known, the `model`) in the JSON report and `report.json`, and each `tasks` entry carries its `usage`; additions to report version 1 ([ADR-0018](https://github.com/jma49/Open-CR-Agent/blob/main/docs/adr/0018-finding-specification.md)).
- SARIF results carry `task` and `model` as properties; the runtime's finding event may name the `model`.
- `ocra review --config <file>` reads that file instead of the repository's (or base branch's) `.ocra/config.json`, also under `--no-repo-config`; plugins it names resolve from its own directory.
- `ocra-eval run --config <file>` passes the file to every review of the run.
- `review()` in `@open-cr-agent/core` runs the pipeline from your own program; the manual's Embedding page lists its contract and how to gate on the report.
- `ocra review --import-sarif <file>` (repeatable) adds an analyzer's SARIF 2.1.0 results on changed lines as findings of their own task (`sarif-<tool>-<n>`, no cost), verified and judged like a reviewer's; ocra runs no tool itself ([ADR-0019](https://github.com/jma49/Open-CR-Agent/blob/main/docs/adr/0019-sarif-import.md)).
- A JSON Schema for the report, `docs/schema/report.v1.json` (draft 2020-12), generated from the code; `reportJsonSchema()` and `reportOutputSchema` in `core` give it to programs.
- Every review has a run id, its session directory's name: in the first progress line, the JSON report's optional `runId`, the summary's Coverage and cost, and SARIF's `automationDetails.id`. `review()` takes `runId`.
- `sampling` in `.ocra/config.json` and `ocra review --temperature <n> --seed <n>` set the sampling of every model call; unset, providers keep their defaults.
- The `direct` runtime sends temperature and seed; the `opencode` runtime sets the temperature on its agents and reports that it has no seed setting.
- The JSON report's optional `provenance` records `ocraVersion`, `promptHash` (the system prompts sent), `configHash` (the effective configuration, secrets left out) and the `sampling` applied.
- `ocra-eval run` reviews at temperature 0 and seed 1 (`--temperature`, `--model-seed`) and records what was applied; `--repeat k` reports the mean and a 95% Student t interval of precision and recall.
- `ocra-eval compare` calls a change between two repeated runs better or worse only when the intervals do not overlap, and warns when the runs differ in version, prompts, configuration or sampling.
- A runtime may report the sampling it applied in an optional `sampling` property, and its factory receives `sampling`.
- `ocra metrics` counts finished reviews in `.ocra/sessions/`: runs by verdict, cost, findings by severity and verification, fixed or dismissed earlier findings and the acceptance rate, per reviewer too; `--since`, `--sessions`, `--format json` (`"version": 1`).
- Action outputs `verdict`, `exit-code`, `run-id`, `findings` and `report` (the JSON report under `$RUNNER_TEMP`), also when the step fails; the input `sarif: true` writes a SARIF log named in the `sarif` output.
- What ocra's packages throw is an `OcraError` with a stable `code` (`CONFIG_INVALID`, `VCS_GIT_FAILED`, `RUNTIME_FAILED`, `BUDGET_EXHAUSTED` and the others the Embedding page lists) and the underlying error as `cause`; `isOcraError()` and `OCRA_ERROR_CODES` come with it.
- An install with `--omit=optional` leaves OpenCode out (11 MB instead of 175 MB) for the `direct` runtime, and the Action's new input `opencode: false` does the same.

### Changed

- `runReview` in `core` is now `review()`; it was never a contract, so callers rename.
- The manual's workflows pin the Action by commit.
- The existing error classes (`GitError`, `GitHubApiError`, `CompletionError`, `PluginError` and the rest) keep their names and messages and extend `OcraError`.
- The CLI's error line names the code, `ocra [CONFIG_INVALID]: …` instead of `ocra: …`; exit codes are unchanged.
- `@open-cr-agent/runtime-opencode` is an optional dependency of `@open-cr-agent/cli`, imported only when a review uses the `opencode` runtime; a default install is unchanged ([ADR-0023](https://github.com/jma49/Open-CR-Agent/blob/main/docs/adr/0023-optional-opencode-runtime.md)).
- A review that needs a runtime that is not installed stops before any model call with exit code 2 and says what to install; `--plan` needs no runtime.
- Each package's main entry exports a curated list instead of everything (`export *`): the Embedding page lists it, and `etc/<package>.api.md` records every name and type.
- `core` keeps `review()` with what it takes and returns, the report output and its schema, `parseSarifLog()`, the plugin interface, the `VcsAdapter` and `AgentRuntime` contracts, the domain types and the error model.
- What the packages share beyond that is in `@open-cr-agent/core/internal` and the other `/internal` entries, which are not a contract; open an issue for anything you need that is gone rather than importing them.

### Removed

- `core` no longer exports the stages and their helpers (`selectFiles`, `bundleFiles`, `anchorFinding`, `judgeFindings`, `verifyFindings`, `planMatrix` and the like), the prompt builders, the zod schemas except `reportOutputSchema`, the runtime helpers (`withFailback`, `ModelHealth`, `reviewTools` and the rest) or `previewReview`.
- The adapters and runtimes export only their plugin, their error class and, for `vcs-local`, the target types: `LocalGitAdapter`, `GitHubApi`, `GitLabApi` and the runtime classes are gone.
- `ReviewOptions` no longer has the test hooks `bundling`, `grouper`, `relocate` and `abortGraceMs`.

### Fixed

- The direct runtime sends a request again once, a second later, after a dropped connection, a 5xx or an answer that is not a chat completion, before failing back to the next model.
- The direct runtime counts an error OpenRouter reports inside a 200 answer by its code (429 as quota, 502 as transient) and quotes such answers, with the key removed.

### Security

- Provider errors no longer carry the key: an endpoint that echoed the `Authorization` header put it in a progress line and the session file. Every configured credential is removed from such errors, in both runtimes.

## [0.2.0] - 2026-09-29

ocra reviews GitLab merge requests, writes SARIF, runs from a container image, and can send reviews to your own OpenAI-compatible endpoint. The fixes found by the 2026-09-30 security audit are in. The GitHub Action is `jma49/Open-CR-Agent@v0.2.0`.

### Added

- `ocra review --mr <iid> [--project <id|path>] [--publish]` reviews GitLab merge requests, on GitLab.com or self-managed: a thread per finding, one summary note updated in place, and later pipelines review only what changed (ADR-0016).
- On GitLab, overrides and dismissals count from people with the Developer role or higher other than the author, in comments nobody else edited.
- GitLab needs `GITLAB_TOKEN` (a project access token with the `api` scope); in GitLab CI, `CI_API_V4_URL` and `CI_PROJECT_ID` are read. The manual has a GitLab CI job.
- New package `@open-cr-agent/vcs-gitlab`.
- `ocra review --format sarif` writes a SARIF 2.1.0 log: one rule per reviewer category, one result per finding with its fingerprint, lines, verification and status. The manual shows the upload to GitHub code scanning.
- `providers` in `.ocra/config.json` declares OpenAI-compatible endpoints (`"type": "openai-compatible"`) such as vLLM, Ollama or a company gateway: `https`, or `http` on this machine; the key named by its environment variable; a price per million tokens for each model (ADR-0017).
- The manual's Model providers page lists what each provider needs and which ones were tested live.
- A container image per release, `ghcr.io/jma49/ocra:<version>` and `latest`, for amd64 and arm64: the published packages installed as the Action does, git, the unprivileged `node` user and build provenance.
- New package `@open-cr-agent/vcs-platform`: the review conversation every platform shares, now used by `vcs-github` (ADR-0016).
- A security policy (`SECURITY.md`, private reporting through GitHub), a contributing guide, a code of conduct, issue templates, and the manual's Stability and support page.
- The threat model, GitHub and GitLab pages say when ocra's rules against the author hold, with a GitHub setup people with push access cannot change: `pull_request_target`, secrets in an environment only the default branch may use, a GitHub App as ocra's account.

### Changed

- Files a spend limit left unstarted are `unreviewed` in the JSON report, no longer `failed`; the run warns how many tasks did not start, and the summary and terminal say the limit was reached.
- The JSON report has an optional `spendLimit` field (`{ usd, reached }`).
- The summary says the next review continues with files a spend limit left, and a review warns when the review state is too large for the summary comment.
- A run warns when model calls used tokens but reported no cost: their model has no price, so the spend limit cannot count them.
- Text ocra posts gets a zero-width space after every `@`, after the `&` of a character reference and after the colon of every `scheme://`; scripts that match comment text exactly may need a change.
- `@open-cr-agent/vcs-github` no longer exports the summary and state helpers (`renderSummary`, `safeMarkdown`, `readState`, `writeState` and the rest); import them from `@open-cr-agent/vcs-platform` under the same names. `inlineComment` is gone.
- Models of the 7 catalog providers whose SDK OpenCode does not bundle, such as `watsonx` and `sap-ai-core`, fail at once with "Failed to initialize provider"; declare one that speaks the OpenAI API under `providers`.
- The manual's GitLab job installs 0.2.0 or uses the image pinned by digest instead of building a clone of `main`.
- The security page says OpenCode fetches its model catalog and tries to install its plugin package from npm when it starts.

### Fixed

- SARIF output doubles `{` and `}` in message text, as SARIF 2.1.0 requires; GitHub code scanning shows them single.
- ocra recognizes inline comments it started, with a marker nobody else edited, so a summary edited by someone else no longer makes it post them again.
- With `npm install --omit=optional`, ocra finds the OpenCode binary that `opencode-ai`'s install script downloads, where npm runs that script, instead of asking for `OCRA_OPENCODE_BIN`.
- A run where one reviewer finished and another failed on the same files no longer says it reviewed nothing; it is still incomplete (exit code `3`), but its verdict, summary and findings stand (#263).

### Security

- Model text can no longer mention people through a character reference (`&#64;name`) or a GitLab username starting with `_` or `.`, nor post a link on GitLab through any scheme, such as `smb://` or `vscode://`.
- An edited marker in a finding thread can no longer redirect a dismissal to a critical finding: a thread of ocra's counts only while nobody else has edited ocra's comment in it.
- A line of model text that starts with `/` gets a zero-width space, so GitLab does not run it as a quick action such as `/merge` or `/approve`.
- `providers` from a configuration named by `extends` count only when it is pinned with `#sha256=`; otherwise they are ignored with a warning that gives the pin.
- A `baseUrl` may not contain `{` or `}`, `apiKeyEnv` may not name an `AWS_` or `AZURE_` credential, and a provider declared as `google` no longer receives the Gemini key.
- GitLab: while a project resolves outdated threads on push, or GitLab does not say, resolving a thread dismisses nothing (a reply still does) and the summary says so; editors are read after the threads.
- GitLab: without `CI_API_V4_URL`, a local `--mr` run stops instead of sending `GITLAB_TOKEN` to GitLab.com, and warns when that URL and `origin` are on different hosts.
- `GITLAB_*` and `CI_*` variables never reach the model runtime, like `GITHUB_*`: GitLab CI puts `CI_JOB_TOKEN` in every job.
- No code is fetched at review time: OpenCode's installs of its plugin package and of provider SDKs go to a local registry that refuses them, and a test checks the runtime reaches only the model providers and the pricing catalog.
- The GitHub Action installs ocra's packages from npm only with provenance from this repository's release workflow and the version's tag; otherwise it builds from source and warns.
- The release publishes only tarballs whose sha512 matches what the `pack` job reported, so the `check` job's third-party install scripts cannot swap them.

## [0.1.2] - 2026-09-29

A run's spend limit now holds, text a model wrote can no longer count as a command or post a link, and OpenCode no longer runs inside the checkout it reviews. The GitHub Action is `jma49/Open-CR-Agent@v0.1.2`.

### Added

- The manual has a threat model, and a way to review pull requests from forks on `pull_request_target` with a maintainer's label as the gate.

### Fixed

- `--max-cost-usd` stops running review tasks, not only new ones (one review with a $2 limit spent $4.70): when the review share (80% of the limit) runs out, they stop, keep their findings, leave their files unreviewed, and the run exits `3`.
- Running tasks report their spend about every 10 seconds; a run can still pass the limit by what each spends between two reports, plus its step in progress.

### Security

- Web addresses in text a model wrote are no longer turned into links, so a pull request cannot plant one for a reviewer to repeat; ocra's own links are unchanged.
- OpenCode runs in an empty directory of its own, not the checkout, so plugins and tools committed in the reviewed code (`.opencode/`, `opencode.json`) cannot load next to the model credentials; a test checks each protection on its own.
- `/ocra override` in model text or in ocra's summary comment no longer counts, even when ocra posts with a person's token and `github.botLogin` is left at its default.

## [0.1.1] - 2026-09-29

The GitHub Action runs the published CLI instead of building the repository on every run, and this is the first release published from GitHub Actions with npm provenance. The CLI and the libraries have not changed since 0.1.0. The GitHub Action is `jma49/Open-CR-Agent@v0.1.1`.

### Added

- The packages are published by `.github/workflows/release.yml` through npm trusted publishing; `npm audit signatures` verifies their provenance, and npmjs.com shows the repository, workflow and commit.

### Changed

- The Action installs `@open-cr-agent/cli` at its own version from npm, into a directory of its own, with every dependency at the version in the tag's `package-lock.json` (with integrity hashes) and install scripts off.
- On the npm registry, `npm audit signatures` checks every installed package's signature and provenance, and a failed check stops the job; with a mirror, only the integrity hashes are checked.
- The Action uses an npm cache of its own and turns off `setup-node`'s automatic npm cache, which saved a cache entry in your repository.
- Setup still takes 8–9 s on GitHub-hosted runners, and puts no build tools next to your model key unless it builds from source.
- The Action builds its ref from source when that version is not on npm yet, npm has it with other dependencies than the ref declares, or the pinned install fails.
- `@main` runs the latest release named on `main` rather than unreleased code, unless `main` changed its dependencies since; pin a release tag or its commit.
- `npm install -g @open-cr-agent/cli` still resolves third-party dependencies when it runs: an `npm-shrinkwrap.json` would install every OpenCode binary, 2.1 GB instead of 175 MB.

## [0.1.0] - 2026-09-28

The first release of ocra (Open-CR-Agent), an open-source multi-agent code reviewer for local changes and GitHub pull requests. It is early: measured on a small set of cases with one family of models, and options may still change; read [what reviews find and miss](https://ocra.majincheng.com/en/docs/quality) before you rely on it.

Install with `npm install -g @open-cr-agent/cli` (Node.js 22.19 or newer, and Git). Reviews run on [OpenCode](https://opencode.ai), installed with ocra, with the models you choose from any provider OpenCode supports and your own API key; start with the [quickstart](https://ocra.majincheng.com/en/docs/quickstart). The GitHub Action is `jma49/Open-CR-Agent@v0.1.0`.

Known limitations: recall is the weak point (the [quality page](https://ocra.majincheng.com/en/docs/quality) has the numbers); quality was measured with Google Gemini models only; GitHub is the only pull request platform; the verdict is advice, not a security gate, since text in the change can steer the models; do not install with `--omit=optional`, which leaves out the OpenCode binary.

### Added

- Reviews of uncommitted changes, a branch, a range, a single commit or a GitHub pull request; the [GitHub Action](https://ocra.majincheng.com/en/docs/github) posts inline comments and one summary, and on the next push reviews only what changed.
- Deterministic stages select and bundle the files, pick reviewers by risk, match rules and anchor every finding to exact lines; correctness, security, performance, docs and `AGENTS.md` reviewers make the judgment calls with read-only tools.
- A verification pass checks each finding against the code and a judge merges duplicates and drops speculation; the verdict follows a fixed rubric, and a critical finding the verifier did not confirm cannot block.
- `--ultra` trades cost for recall: every reviewer at every risk tier, two samples each, a plan phase, and the callers of changed symbols.
- `ocra memory` records findings a team accepts, and dismissals and replies in pull request threads count on later reviews.
- Plugins for VCS adapters, agent runtimes, reviewers, rules, tools and event listeners.
- `ocra review --plan` shows the files, tasks and prompt sizes of a review without calling a model.
- `--max-cost-usd` (or `maxCostUsd` in `.ocra/config.json`) sets a run's spend limit; every run reports tokens and dollars.
- Caps on steps per agent (30), tasks per run (60 by default) and run time; each model tier takes a failback chain that waits out short rate limits and drops a model out of quota.
- The JSON report (`--format json`) and `--plan --format json` are versioned (`"version": 1`); later releases only add optional fields, or change the version.

### Security

- Agents cannot write files, run commands or browse; likely secret files cannot be read; configuration comes from the base branch; text from the change is fenced off in every prompt.

[Unreleased]: https://github.com/jma49/Open-CR-Agent/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/jma49/Open-CR-Agent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jma49/Open-CR-Agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jma49/Open-CR-Agent/releases/tag/v0.1.0
