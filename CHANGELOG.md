# Changelog

Changes to the `@open-cr-agent/*` packages and the GitHub Action. The packages are released together at one version. While that version is 0.x, a minor release may change options, configuration and output; each such change is listed here.

## Unreleased

### New

- **A second runtime.** `"runtime": "direct"` reviews through the model endpoints declared under `providers` without OpenCode: a tool loop over the OpenAI chat completions API, the same step cap, failback and prices, and nothing else on the network, no pricing catalog, no package install. It refuses models of providers that are not declared; those stay with `opencode`, the default. New package `@open-cr-agent/runtime-direct` ([ADR-0020](https://github.com/jma49/Open-CR-Agent/blob/main/docs/adr/0020-direct-runtime.md)). The runtime conformance suite in `core` runs against both.
- **Finding provenance.** Each finding in the JSON report and in `report.json` carries `provenance`: the `task` in `tasks` that reported it and, when the runtime names it, the `model`. Each entry in `tasks` carries its `usage` (tokens and cost). Both are additions to report version 1. SARIF results carry `task` and `model` as properties. The runtime's finding event may name the model (`model`, optional) ([ADR-0018](https://github.com/jma49/Open-CR-Agent/blob/main/docs/adr/0018-finding-specification.md)).
- **A configuration file of your own.** `ocra review --config <file>` reads that file instead of the repository's `.ocra/config.json` (or the base branch's, with `--pr` and `--mr`). It applies with `--no-repo-config` too, so reviews of code you do not trust can still use declared model endpoints and limits; plugins it names are resolved from its own directory. `ocra-eval run --config <file>` passes it to every review of a run.
- **The library entry.** `review()` in `@open-cr-agent/core` runs the pipeline from your own program; the manual's new Embedding page lists the options that are a contract, what the report is and how to gate on it. It was `runReview`, never a contract; callers rename.
- **Analyzer results.** `ocra review --import-sarif <file>` (repeatable) adds the results of a SARIF 2.1.0 log an analyzer wrote, Semgrep's or CodeQL's for instance, to the review: only results on lines the change touches, as findings of a task of their own (`sarif-<tool>-<n>`, no cost), verified and judged like a reviewer's. ocra runs no tool itself ([ADR-0019](https://github.com/jma49/Open-CR-Agent/blob/main/docs/adr/0019-sarif-import.md)).
- **A JSON Schema for the report.** `docs/schema/report.v1.json` (draft 2020-12) is generated from the code and tested against it; `reportJsonSchema()` and `reportOutputSchema` in `@open-cr-agent/core` give the same schema to programs.
- **A run id.** Every review has one id, the name of its session directory: the first progress line names it, the JSON report carries it as `runId` (an optional addition to version 1), the summary comment shows it under Coverage and cost, and the SARIF log carries it as `automationDetails.id`. `review()` takes `runId`; without it one is generated.
- **Reproducible evaluation.** `sampling` in `.ocra/config.json` and `ocra review --temperature <n> --seed <n>` set the sampling of every model call; unset, providers keep their defaults as before. The `direct` runtime sends both; the `opencode` runtime sets the temperature on its agents and has no seed setting, which it reports. The JSON report gains `provenance` (an optional addition to version 1): `ocraVersion`, `promptHash` (the system prompts the configuration sends), `configHash` (the effective configuration, secrets left out) and the `sampling` applied. `ocra-eval run` reviews at temperature 0 and seed 1 (`--temperature`, `--model-seed`), records what was applied, and `--repeat k` reviews the selection k times and reports the mean and a 95% Student t interval of precision and recall; `ocra-eval compare` calls a change between two repeated runs better or worse only when the intervals do not overlap, and warns when runs differ in version, prompts, configuration or sampling. A runtime may say what it applied in a new optional `sampling` property, and its factory receives `sampling`.
- **`ocra metrics`.** Counts over the finished reviews in `.ocra/sessions/`: runs by verdict, cost, findings by severity and verification, what became of earlier findings (fixed or dismissed, and their ratio as the acceptance rate), and the same per reviewer; `--since`, `--sessions`, and `--format json` with `"version": 1` for dashboards and scripts.
- **Action outputs.** The GitHub Action sets `verdict`, `exit-code`, `run-id`, `findings` and `report` (a copy of the JSON report under `$RUNNER_TEMP`), also when the step fails, and with the new input `sarif: true` writes a SARIF log and names it in the `sarif` output. The manual's workflows now pin the Action by commit.
- **One error model.** What ocra's packages throw is an `OcraError` with a stable `code` (`CONFIG_INVALID`, `VCS_GIT_FAILED`, `RUNTIME_FAILED`, `BUDGET_EXHAUSTED` and the others the Embedding page lists) and, where there is one, the underlying error as `cause`; `isOcraError()` and `OCRA_ERROR_CODES` come with it. The existing error classes (`GitError`, `GitHubApiError`, `CompletionError`, `PluginError` and the rest) keep their names and now extend it. Messages are unchanged. The CLI's error line names the code: `ocra [CONFIG_INVALID]: …` instead of `ocra: …`; exit codes are unchanged.
- **OpenCode is optional.** `@open-cr-agent/runtime-opencode` is now an optional dependency of `@open-cr-agent/cli`, imported only when a review uses the `opencode` runtime; a default install is unchanged. A project install with `--omit=optional` leaves OpenCode out (11 MB instead of 175 MB) for the `direct` runtime, and the GitHub Action's new input `opencode: false` does the same. A review that needs the missing runtime stops before any model call with exit code 2 and says what to install; `--plan` needs no runtime ([ADR-0023](https://github.com/jma49/Open-CR-Agent/blob/main/docs/adr/0023-optional-opencode-runtime.md)).

### Changes that may need action

- **A curated public API.** Each package's main entry now exports a named list instead of everything (`export *`); the Embedding page lists it, and `etc/<package>.api.md` in the repository records every name and type. `@open-cr-agent/core` keeps `review()` and what it takes and returns, the report output and its schema, `parseSarifLog()`, the plugin interface, the `VcsAdapter` and `AgentRuntime` contracts, the domain types and the error model. Gone from it: the stages and their helpers (`selectFiles`, `bundleFiles`, `anchorFinding`, `judgeFindings`, `verifyFindings`, `planMatrix` and the like), the prompt builders, the zod schemas except `reportOutputSchema`, the runtime helpers (`withFailback`, `ModelHealth`, `reviewTools` and the rest) and `previewReview`. The adapters and runtimes export their plugin, their error class and, for `vcs-local`, the target types; `LocalGitAdapter`, `GitHubApi`, `GitLabApi` and the runtime classes are no longer exported. What ocra's packages share beyond that is in `@open-cr-agent/core/internal` and the other `/internal` entries, which are not a contract and may change in any release. To migrate: build on `review()` and the plugins as the Embedding page shows; if you need something that is gone, open an issue saying what for, rather than importing `/internal`. `ReviewOptions` no longer has the test hooks `bundling`, `grouper`, `relocate` and `abortGraceMs`; drop them.

### Fixed

- **The direct runtime survives a transient endpoint failure.** A dropped connection, a 5xx, or an answer that is not a chat completion is sent again once, a second later, before the failback moves to the next model; an error OpenRouter reports inside a 200 answer counts by its code (a 429 as quota, a 502 as transient); and such errors quote the answer, with the key removed, instead of saying only "not a chat completion".
- **Provider errors no longer carry the key.** When a model endpoint echoed the request's `Authorization` header in an error, the OpenCode runtime passed that text on as a progress line and into the session file. Every configured provider credential is now replaced in such errors; the new `direct` runtime does the same.

## 0.2.0

ocra now reviews GitLab merge requests, writes SARIF for code scanning, runs from a container image, and can send reviews to your own OpenAI-compatible model endpoint. A security audit of these changes found that text a model wrote could still mention people or post links, and that an edited comment could redirect a dismissal; both are fixed, with the rest of its findings ([audit](https://github.com/jma49/Open-CR-Agent/blob/main/docs/audits/2026-09-30-m9-security.md)).

### New

- **GitLab merge requests.** `ocra review --mr <iid> [--project <id|path>] [--publish]` reviews a GitLab merge request, on GitLab.com or self-managed GitLab, and posts a thread on each finding in the diff and one summary note, updated in place. Later pipelines review only what changed. The rules are GitHub's: overrides and dismissals from people with the Developer role or higher other than the author, in comments nobody else edited. It needs `GITLAB_TOKEN`, a project access token with the `api` scope; in GitLab CI, `CI_API_V4_URL` and `CI_PROJECT_ID` are read. The manual has a GitLab CI job. New package `@open-cr-agent/vcs-gitlab` (ADR-0016).
- **SARIF output.** `ocra review --format sarif` writes the review as a SARIF 2.1.0 log for code scanning and security dashboards: one rule per reviewer category, one result per finding, with its fingerprint, lines, verification and status. The manual shows how to upload it to GitHub code scanning from the Action.
- SARIF output doubles `{` and `}` in message text, as SARIF 2.1.0 requires (a single brace pair such as `{0}` is a placeholder). GitHub code scanning shows the doubled braces as single ones.
- **Your own model endpoint.** `.ocra/config.json` may declare providers that speak the OpenAI API (`providers`, `"type": "openai-compatible"`): a self-hosted vLLM or Ollama server, or a company gateway. The endpoint must be `https`, or `http` on this machine. The key is named by its environment variable, never written in the file, and only that variable reaches the runtime. Every model has a price per million tokens, so cost and the spend limit count it (ADR-0017). The new Model providers page lists what each provider needs and which ones were tested live. The security page now says that OpenCode fetches its model catalog and tries to install its plugin package from npm when it starts, neither of which a review needs.
- **A container image.** Each release is also `ghcr.io/jma49/ocra:<version>` (and `latest`), for amd64 and arm64: the published packages installed as the GitHub Action installs them, git, the unprivileged `node` user, and build provenance. For GitLab CI, Jenkins and other runners.
- **New package `@open-cr-agent/vcs-platform`**: the review conversation every platform shares (who may override or dismiss, which state counts, the summary and inline comment text), which `vcs-github` now uses (ADR-0016). `@open-cr-agent/vcs-github` no longer exports the summary rendering and the review state; import them from `@open-cr-agent/vcs-platform`.

### Security

- **No mentions or links through the back door.** Model text could still mention people through a character reference (`&#64;name`, which GitHub renders as a mention) or a GitLab username that starts with `_` or `.`, and on GitLab an address of any scheme, such as `smb://` or `vscode://`, became a link. Every `@` and character reference in posted text now gets a zero-width space, and so does every address, after its scheme's colon. Found by the 2026-09-30 audit.
- **An edited finding thread counts for nothing.** Someone with write access could edit the hidden marker in the thread of a minor finding to name a critical one; a reviewer who then resolved or answered that thread dismissed the critical finding. A thread of ocra's now counts only while nobody else has edited ocra's comment in it.
- **A line of model text that starts with a slash is posted with a zero-width space before it**, in the summary and in inline comments. GitLab runs a comment line such as `/merge` or `/approve` as a quick action with the rights of the token that posted it. ocra neutralized only its own `/ocra` commands.
- **Provider declarations are stricter.** A shared configuration named by `extends` may declare `providers` only when pinned with `#sha256=`; an unpinned one is ignored with a warning that gives the pin to add, because a provider decides where the code under review goes. A `baseUrl` may not contain `{` or `}`, which OpenCode would replace with a variable or a file's content (the checkout's `.git/config` holds its token). `apiKeyEnv` may not name an `AWS_` or `AZURE_` credential either, and a provider declared with the id `google` no longer receives the Gemini key. Found by the 2026-09-30 audit.
- **GitLab: a push is not a dismissal.** In a project that resolves outdated threads on push, GitLab records whoever pushed as the one who resolved a thread, so another developer's push counted as a reviewer dismissing ocra's findings. ocra now reads that setting on every run; while it is on, or GitLab does not say, resolving a thread dismisses nothing (a reply still does), and the summary says so. Who edited a thread's notes is also read after the threads themselves, so a reply edited in between no longer counts as unedited.
- **GitLab: the token goes only where you point it.** Without `CI_API_V4_URL`, a local `--mr` run sent `GITLAB_TOKEN` to GitLab.com even when `origin` was a self-managed instance. ocra now stops in that case and asks for `CI_API_V4_URL`, and warns when that URL and `origin` are on different hosts. Found by the 2026-09-30 audit.
- `GITLAB_*` and `CI_*` variables never reach the model runtime by name prefix, like `GITHUB_*`: GitLab CI puts `CI_JOB_TOKEN` in every job.
- **No code is fetched at review time.** OpenCode tries to install its own plugin package from npm on every start, and the SDK of a provider it does not bundle when a model first uses it. ocra now sends both installs to a registry on this machine that refuses them at once: no package is downloaded and no `.npmrc` token is sent. At review time the runtime reaches only the model providers and OpenCode's pricing catalog, and a test checks this with every other address refused. The 7 catalog providers that need a download (such as `watsonx` and `sap-ai-core`) now fail at once with "Failed to initialize provider"; the Model providers page lists them.
- **The release publishes only what it packed.** The `pack` job reports each tarball's sha512 as a job output, and `publish` refuses a tarball that does not match. The tarballs travel as an artifact through the run in which `check` runs third-party install scripts, which could have replaced them and had them published with genuine provenance. Found by the 2026-09-30 audit.

### Changes and fixes

- **What a spend limit leaves is named.** Files whose review tasks the limit never started are reported as not reviewed (`unreviewed`), no longer as failed. The run warns how many tasks did not start. The pull request summary and the terminal say the spend limit was reached, and the JSON report has a new optional `spendLimit` field (`{ usd, reached }`). A pull request's next review already continued with those files; the summary now says so. When the review state is too large for the summary comment, and the next review has to start over, the review warns.
- A run warns when model calls used tokens but reported no cost, because their model has no price and the spend limit cannot count them.
- **ocra recognizes its own inline comments.** A finding whose thread ocra started, with a marker comment nobody else edited, is not commented again, even when the summary's state is missing or cannot be trusted. Before, a summary edited by someone else made ocra post its earlier inline comments again.
- With `npm install --omit=optional`, ocra now finds the OpenCode binary that `opencode-ai`'s install script downloads, where npm runs that script. It used to stop and ask for `OCRA_OPENCODE_BIN`.
- A run no longer says it reviewed nothing when one reviewer finished its tasks and another failed on the same files (#263). Such a run is still incomplete (exit code `3`), but its verdict, summary and findings now stand.

### Changes that may need action

- Models of the 7 catalog providers whose SDK OpenCode does not bundle, such as `watsonx` and `sap-ai-core`, now fail at once with "Failed to initialize provider" instead of downloading code during the review. If such a service speaks the OpenAI API, declare it under `providers`.
- In the JSON report, a file whose review tasks a spend limit never started is `unreviewed`, no longer `failed`.
- Text ocra posts gets a zero-width space after every `@`, after the `&` of a character reference, and after the colon of every `scheme://`. The wording of comments is not a contract, but a script that matches it exactly may need a change.
- `@open-cr-agent/vcs-github` no longer exports the summary and state helpers (`renderSummary`, `safeMarkdown`, `readState`, `writeState` and the rest). They are in `@open-cr-agent/vcs-platform` under the same names, except `inlineComment`, which is gone.

### Documentation

- **Who controls the pipeline.** The threat model, the GitHub page and the GitLab page now say when ocra's rules against the author hold. For a GitLab merge request from a branch of the same project, the author writes the pipeline and can read its variables, so the review is advice they could forge; the page lists what limits that. GitHub gets a setup that people with push access can neither change nor impersonate: `pull_request_target`, secrets in an environment only the default branch may use, and a GitHub App as ocra's account. The GitLab job no longer builds ocra from a clone of `main`; it installs 0.2.0 or uses the image pinned by digest.
- A security policy (`SECURITY.md`, with private reporting through GitHub), a contributing guide, a code of conduct and issue templates. The manual's new Stability and support page lists what counts as a contract and how it may change between releases.

### GitHub Action

- Use `jma49/Open-CR-Agent@v0.2.0`.
- The GitHub Action installs ocra's packages from npm only when their provenance shows they were built by this repository's release workflow from the version's tag. Otherwise, for example for a version published from a stolen npm login, it builds its own source and warns. `npm audit signatures` alone passed packages that have no provenance.

## 0.1.2

A run's spend limit now holds, text a model wrote can no longer count as a command or post a link, and OpenCode no longer runs inside the checkout it reviews.

### Packages

- **`--max-cost-usd` stops running review tasks.** It used to stop only new ones from starting, so tasks already running went on: one review with a $2 limit spent $4.70.
  - Running tasks now report their spend about every 10 seconds.
  - When the review share (80% of the limit) runs out, every running review task stops. It keeps what it found, its files count as not reviewed, and the run exits `3`.
  - A run can still pass the limit by what each running task spends between two reports, plus its step in progress.
- **Web addresses in text a model wrote stay text.** A pull request could plant an address, in a code comment for example, and get a reviewer to repeat it; the adversarial probe saw exactly that. Posted, it became a link in a comment from ocra. Addresses in findings and summaries now read the same but are no longer turned into links. ocra's own links are unchanged.
- **OpenCode runs in an empty directory of its own**, not in the checkout under review. Before, only a setting that turns off OpenCode's project configuration kept plugins and custom tools committed in the reviewed code (`.opencode/`, `opencode.json`) from loading next to the model credentials. A test now plants them and checks each of the two protections on its own.
- **Commands never come from ocra's own comments.** `/ocra override` in text a model wrote, or anywhere in ocra's summary comment, no longer counts, even when ocra posts with a person's token and `github.botLogin` is left at its default. In that configuration, a judge summary that repeated an override planted in the pull request could let a blocked pull request pass.

### GitHub Action

- Use `jma49/Open-CR-Agent@v0.1.2`.
- The manual now has a threat model, and a way to review pull requests from forks on `pull_request_target` with a maintainer's label as the gate.

## 0.1.1

The GitHub Action now runs the published CLI instead of building the repository on every run. This is also the first release published from GitHub Actions with npm provenance. The CLI and the libraries have not changed since 0.1.0.

### GitHub Action

- Use `jma49/Open-CR-Agent@v0.1.1`.
- It installs `@open-cr-agent/cli` at the Action's own version from npm, into a directory of its own.
  - Every dependency is at the version the release was tested with: the tag's `package-lock.json`, with integrity hashes.
  - Install scripts are off.
  - On the npm registry, `npm audit signatures` checks the registry's signature on every installed package, and its provenance where it has one. A failed check stops the job. With a mirror configured, only the lockfile's integrity hashes are checked.
  - It uses an npm cache of its own, not `~/.npm`, and turns off `setup-node`'s automatic npm cache, which would have saved a cache entry in your repository.
- Setup takes about as long as before: 8–9 s on GitHub-hosted runners, either way. What changes is what runs:
  - the published packages, with provenance from this release on;
  - no build tools with your model key in the environment, unless it builds from source (below).
- It still builds the Action's ref from source when:
  - that version is not on npm yet (a release's first minutes);
  - npm has that version with other dependencies than the ref declares;
  - the pinned install fails.
- `@main` now runs the latest release named on `main` rather than unreleased code, unless `main` has changed its dependencies since. Pin a release tag or its commit.

### Packages

- Published by `.github/workflows/release.yml` through npm trusted publishing. `npm audit signatures` verifies each package's provenance, and each package's page on npmjs.com shows the repository, workflow and commit it was built from.
- `npm install -g @open-cr-agent/cli` still resolves third-party dependencies when it runs. Pinning them with an `npm-shrinkwrap.json` would make npm install every OpenCode binary for every OS and CPU, 2.1 GB instead of 175 MB.

## 0.1.0

The first release of ocra (Open-CR-Agent), an open-source multi-agent code reviewer for local changes and GitHub pull requests. It is early: it has been measured on a small set of cases, with one family of models, and options may still change. Read [what reviews find and miss](https://ocra.majincheng.com/en/docs/quality) before you rely on it.

### Install

```bash
npm install -g @open-cr-agent/cli
ocra --version
```

Requires Node.js 22.19 or newer and Git. Reviews run on [OpenCode](https://opencode.ai), which is installed with ocra, and on the models you choose from any provider OpenCode supports, with your own API key. Start with the [quickstart](https://ocra.majincheng.com/en/docs/quickstart). The GitHub Action is `jma49/Open-CR-Agent@v0.1.0`.

### What it does

- Reviews uncommitted changes, a branch, a range, a single commit or a GitHub pull request. The [GitHub Action](https://ocra.majincheng.com/en/docs/github) posts inline comments and one summary, and on the next push reviews only what changed.
- Deterministic stages select and bundle the files, pick the reviewers by risk, match rules and anchor every finding to exact lines. The models make the judgment calls: correctness, security, performance, docs and `AGENTS.md` reviewers with read-only tools.
- A verification pass checks each finding against the code, and a judge merges duplicates and drops speculation. The verdict comes from a fixed rubric, and a critical finding the verifier did not confirm cannot block.
- `--ultra` trades cost for recall: every reviewer at every risk tier, two samples each, a plan phase, and the callers of changed symbols.
- It remembers decisions: `ocra memory` records findings a team accepts, and dismissals and replies in pull request threads count on later reviews.
- Everything is a plugin: VCS adapters, agent runtimes, reviewers, rules, tools and event listeners.
- Hardened for pull requests from outside contributors: agents cannot write files, run commands or browse; likely secret files cannot be read; configuration comes from the base branch; text from the change is fenced off in every prompt.

### Cost controls

- `ocra review --plan` shows the files, tasks and prompt sizes of a review without calling a model.
- `--max-cost-usd` (or `maxCostUsd` in `.ocra/config.json`) sets a spend limit for a run. Every run reports tokens and dollars.
- Steps per agent (30), tasks per run (60 by default) and run time are capped. Each model tier takes a failback chain: short rate limits are waited out, and a model out of quota is dropped for the rest of the run.

### Known limitations

- Recall is the weak point: reviewers miss issues a careful human reviewer would find. The [quality page](https://ocra.majincheng.com/en/docs/quality) has the numbers and how they were measured.
- Quality has been measured with Google Gemini models only.
- GitHub is the only pull request platform.
- The verdict is advice, not a security gate: the models read the change, and text in it can steer them.
- Do not install with `--omit=optional`: the OpenCode binary comes as an optional package, and without it `ocra review` stops and asks for `OCRA_OPENCODE_BIN`.
- The JSON report (`--format json`) and `--plan --format json` are versioned (`"version": 1`); later releases only add optional fields, or change the version.
