# Changelog

All notable changes to the `@open-cr-agent/*` packages and the GitHub Action. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages, released together at one version, follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While that version is 0.x, a minor release may change options, configuration and output; each such change is listed here.

Entries come from the changesets in `.changeset/`, one per pull request that changes what users see; [.changeset/README.md](.changeset/README.md) says how to write one.

## [Unreleased]

## [0.6.0] - 2026-10-04

Hardening and reliability for ocra Cloud users: concurrent runs no longer sign each other out, an unreachable or ended session says so instead of silently running signed out, shared findings are redacted with the same rules on the machine and the server, and every answer from ocra Cloud is checked before use. Using the `ocra` command does not change: install, flags and the JSON report work as before, and `docker run <image> ocra review …` keeps working. Code that embeds the engine should read **Changed**: `ReviewOptions` groups its settings and the CLI package's public entry is `run(argv)`. The Action's tag for this release is `jma49/Open-CR-Agent@v0.6.0`.

### Added

- Error code `CLOUD_API_FAILED`: `ocra login` and `ocra whoami` name it when ocra Cloud cannot be reached or answers something unusable.
- `@open-cr-agent/cloud-contract`: the wire contract between the CLI and ocra Cloud as one package of Zod schemas and constants (upload, preferences, memory and device sign-in shapes, upload limits, verdict, tier and effort vocabularies, provider ids, error codes), with the redaction pass and its test vectors. Its first publish is by hand, before the release that includes it.
- A finding may carry a `fix` (`{ startLine, endLine, replacement }`), in the JSON report and as SARIF `fixes`; no reviewer produces one yet ([ADR-0029](https://github.com/jma49/Open-CR-Agent/blob/main/docs/adr/0029-committable-suggestions.md)).
- An inline comment on exactly a fix's lines ends with a committable suggestion: GitHub's `suggestion` block, GitLab's `suggestion:-N+0`, posted as written or not at all.
- Error code `upstream_redirect` (502): ocra Cloud's gateway refuses a provider's redirect rather than resend the key elsewhere.
- `errorMessage(error)`, the message of any thrown value, for runtimes and other callers of the public API.
- `MODEL_TIERS`, the model tiers strongest first; `ModelTier` is derived from it.
- The `opencode` runtime sends the configured reasoning effort: `reasoningEffort` for OpenAI, a thinking budget for Claude 4+ and Gemini 2.5, `thinkingLevel` for Gemini 3, one OpenCode variant per model and level.
- `effortCapability(model)` in `@open-cr-agent/core`: ocra's table of the parameter and levels a model takes; `AppliedSettings.unsupported` names models a level was left out for.
- `ocra review --plan` estimates each task's input cost at the input price of its chain's first model, and the total; models priced at 0 or through ocra Cloud show as unpriced, catalog-priced models as of unknown price. The plan JSON carries `inputCost` per task and in total.
- A JSON Schema for `ocra review --plan --format json` (`docs/schema/plan.v1.json`), generated from the code and tested against it.
- `resolveGitHubTarget` and `resolveGitLabTarget` find a pull or merge request the way `ocra review --pr` and `--mr` do, with their token, API address and origin rules, and make its adapter; `vcs-platform` exports the types they share (`ResolveTargetOptions`, `PlatformTarget`, `ChangeRequestRef`, `LocalCode`).
- The review state on GitHub and GitLab records the reviewer of each finding, and the JSON report's `rereview` entries carry it as `reviewer`; `PriorFinding.reviewer` is optional, so state written before still loads.
- `ChainRunner` and `ModelAttempts` in `@open-cr-agent/core`: a runtime implements one attempt on one model, and the runner picks the chain, keeps each model's health and fails over, as both built-in runtimes now do; `AttemptOutcome`, `AttemptError` and `QuotaError` describe an attempt.
- What a runtime needs besides `ChainRunner` is public in `@open-cr-agent/core`: `reviewTools`, `REVIEW_TOOLS`, `MAX_AGENT_STEPS`, `RESUME_MESSAGE`, `parseModel`, `parseQuotaError`, `withoutSecrets`, `emptyUsage`, `addUsage`, `EFFORT_LEVELS`, `thinkingBudget` and `proxiedFetch`. The built-in runtimes import nothing from `@open-cr-agent/core/internal`.
- `vcs-platform` exports the schemas the platform adapters' options share: `codeSourceSchema`, `historySchema`, `changeRequestSchema`, `commitIdSchema` and `fetchSchema`.

### Changed

- `run(argv)` takes only the arguments and writes to stdout and stderr; the output streams and the dependencies it took for tests are no longer public.
- Every call to ocra Cloud sends the `ocra/<version>` user agent and waits up to 30 seconds; each answer is checked before it is used, and one that does not fit is treated like a refusal.
- The CLI reads and sends ocra Cloud's shapes through `@open-cr-agent/cloud-contract`; what it sends and accepts is unchanged.
- `ReviewPlatform` (`@open-cr-agent/vcs-platform`) requires `suggestionFence`, the platform's suggestion syntax.
- A level the capability table does not list for a model is left out of its calls on `opencode`, with one warning per agent; calls that send an effort run without the configured temperature.
- The line "From your ocra Cloud settings: …" names the settings in the order `--plan` lists them.
- `NpmRunner` takes the directory to run npm in as a second argument; a custom runner should run npm there.
- `ReportOutput`, `OutputFinding` and `OutputPriorFinding` are derived from `reportOutputSchema`; the report's JSON is unchanged.
- `reportOutputSchema` rejects an optional field present with the value `undefined`; JSON input is unaffected.
- After upgrading, a repository whose remote is written in SSH form, or with a port or a trailing `/`, gets a new hash once: earlier uploads and account memory recorded under the old hash do not match it until they are recorded again. HTTPS remotes keep their hash.
- `ReviewOptions` groups its settings: `limits` (`concurrency`, `taskTimeoutMs`, `runTimeoutMs`, `maxCostUsd`, `maxTasks`), `stages` (`verify`, `judge`), `mode` (`full`, was `fullReview`; `ultra`) and `identity` (`runId`, `provenance`).
- `ReviewOptions.selection` takes any of its fields; the rest keep their defaults.
- The direct runtime words a tier without a model as the OpenCode runtime does: `No model configured for the "<tier>" tier; set models.<tier> in .ocra/config.json or OCRA_MODEL_<TIER>`.
- A shared configuration (`extends`) with an invalid value is ignored, with the usual warning, even when the repository's file sets that key itself; before, the file's value hid the invalid one.
- The `snapshot` option of the `github` and `gitlab` adapters is the change request as ocra reads it (validated commit ids), not GitHub's or GitLab's API answer; `resolveGitHubTarget` and `resolveGitLabTarget` build it.
- `ocra memory add` says why a session's report cannot be read instead of finding nothing in it.
- The OpenCode runtime validates the session messages it reads; an answer in another shape fails the task with the reason instead of being read in part.

### Removed

- The `@open-cr-agent/vcs-github/internal` and `@open-cr-agent/vcs-gitlab/internal` entries, which only the CLI used and were not a contract.

### Fixed

- `pluginSettings` from your ocra Cloud account are looked up by the package name the account lists, as ocra Cloud stores them, so a plugin whose package and plugin names differ now gets its settings.
- The ocra Cloud credentials and salt files are written atomically (0600, temporary file and rename); a credentials file that holds no session reads as signed out with one warning instead of failing every review, and `ocra logout` removes it.
- ocra Cloud's providers list is checked before use: an answer that is not a list stops the review with an error instead of a crash, a malformed entry is left out, and the effort style a provider lists (`openai` or `openrouter`) is used, an unknown one ignored with a warning.
- Upgrading fixes concurrent ocra runs on one machine signing each other out of ocra Cloud: one process refreshes at a time under a lock beside `credentials.json`, always with the refresh token it re-reads inside the lock, and a refresh refused because another process rotated the token takes that process's saved pair instead of signing out.
- A review whose ocra Cloud session ended warns `your ocra Cloud session ended: run ocra login`, and one that cannot reach ocra Cloud warns once that it runs without the account's rules, limits (`maxCostUsd` included), models, memory and upload, instead of silently running signed out; with an `ocra-` model the error says ocra Cloud could not be reached rather than asking to sign in.
- A 401 for a live token renews the session once and retries once; a 404 for the account settings is no settings, without a warning.
- `ocra login` saves the session even when it cannot read the login.
- A run with ocra Cloud models and `"runtime": "direct"` renews the gateway token before it expires, so runs longer than an hour keep their model calls; with `opencode`, the token is sized to outlive `runTimeoutMinutes`, with a warning when no token can.
- `taskTimeoutMinutes` and `runTimeoutMinutes` above 35791 (about 24.8 days) are refused instead of making every task time out at once; `review()` cuts a longer `taskTimeoutMs` or `runTimeoutMs` to that limit.
- The parsed types of the per-agent settings name their keys (`reviewers.<id>.models`, `roles.<role>.effort`) instead of `{}`.
- `ocra review --help` says `--no-upload` sends nothing about the review: no counts, per-reviewer counts or findings.
- `ocra review --plan` names each setting's real source: `shared` for a shared configuration (`extends`) and `env` for `OCRA_MODEL_*` and `OCRA_EFFORT_*`, which it reported as `file`; a combined list names the layers it combines, such as `shared+account`. The sources are recorded by the merge that applies the settings, so the plan cannot drift from the review.
- `ocra review --mr --publish` says "merge request", not "pull request", when Ctrl-C comes while it publishes.
- ocra Cloud gets one repository hash per repository, whatever form its remote URL takes (`git@host:o/r`, `ssh://`, `https://`, with a user, a port, a trailing `/` or `.git`), so SSH clones and HTTPS CI group together and match the account's memory.
- With `--pr` or `--mr`, the hash is the pull or merge request's repository, not the checkout's origin.
- When ocra Cloud cannot be reached, a review hashes with the account salt saved at the last answer instead of this machine's.
- A review warns once when the account remembers findings but does not share findings, so its memory cannot apply.
- `ocra metrics` and the ocra Cloud upload credit a fixed or dismissed finding to the reviewer that reported it, even when the review that sees it fixed no longer has a finding with its fingerprint.
- The counts sent to ocra Cloud agree with the exit code: a review with a critical finding it could not verify is uploaded as incomplete, and timed-out tasks count as failed, as they do per reviewer.

### Security

- Shared findings: the redaction pass before upload matches ocra Cloud's and runs the same test vectors. It now also covers a finding's file path and category, keys that contain `/`, hex keys, the password in a URL, Slack and Discord webhook URLs, and quoted values assigned to names such as `password` or `api_key`. Hex runs of 32 or more characters, digests included, now read `[redacted]`.
- Model ids, provider names and gateway paths from ocra Cloud are validated before they reach the runtime configuration; others are dropped with a warning.
- The OpenCode runtime refuses `{` and `}` in every declared provider's id, address and model names, not only those from a configuration file.
- `ocra login` opens only the sign-in page's own address on the server in use, and on Windows opens it without a command interpreter; any other address is printed for the user to open.
- Account settings named on the terminal are escaped like other untrusted text.
- `ocra plugins allow` runs npm from the plugin directory, so the current project's npm configuration does not apply, and refuses a package whose registry entry lists no integrity.

## [0.5.0] - 2026-10-04

ocra Cloud configures everything the CLI reads: models and effort per agent, limits, checking, file selection, path rules, plugins (allowed per machine) and the recall mode, all under the repository's own configuration, with `--plan` showing where each setting came from. Signed-in reviews also send per-reviewer counts, and, only when the account turns it on, their findings, so the web can show a review in full and remember findings across machines. The Action's tag for this release is `jma49/Open-CR-Agent@v0.5.0`.

### Added

- While signed in, a review also takes the limits, `verify`, `judge`, `sampling`, `include`, `exclude` and path rules from your ocra Cloud account, under the configuration: what the configuration sets wins, and `include`, `exclude` and rules combine (ADR-0027).
- `ocra review --plan` reads the account settings too and lists every setting with its source (`file`, `account`, `file+account` or `default`), in text and in the JSON plan's `settings`; offline, it warns and shows the configuration alone.
- The JSON report's `provenance.rules` lists the rules a review was given with their `source`, and `provenance.accountSettings.version` the account settings used; the configuration hash covers them. `ReviewOptions.rules` takes an optional `source` per rule (`SourcedRule`).
- `ocra plugins allow <name>@<version>`, `ocra plugins deny <name>` and `ocra plugins list`: allow on this machine a plugin your ocra Cloud settings name. `allow` shows the package and its publisher, installs that exact version with install scripts off into `~/.config/ocra/plugins/`, and records its integrity (ADR-0027).
- A signed-in local review loads the plugins your ocra Cloud settings name that this machine allowed, from that directory only, with the account's `pluginSettings` for them; never for `--pr`, `--mr` or with `--no-repo-config`. A plugin not allowed is skipped with one warning.
- A model or failback chain per reviewer (`reviewers.<id>.models`) and per role (`roles.<verifier|judge|helper>.models`); an agent without one keeps its tier's chain (ADR-0025).
- Task specs and completion requests carry an agent's own chain as `models`, and runtime factories receive every agent chain in `agentModels`; both built-in runtimes run those calls on it, with failback and a circuit breaker shared per model.
- The JSON report's `provenance.agents.<id>.models` records each agent's chain, and `--plan` shows each task's chain.
- While signed in, a review takes the runtime, tier models and effort, and each reviewer's and role's model and effort from your ocra Cloud Agents page wherever the repository's configuration leaves them out, and prints what it took.
- A signed-in review applies the findings your ocra Cloud account remembers for the repository together with `.ocra/memory.json` (a finding both list counts as the repository's), and prints how many the account's memory hid (ADR-0028).
- The JSON report's `remembered` entries carry their `source` (`repository` or `account`); `ReviewOptions.accountMemory` takes the account's entries, and `MemorySource` and `RememberedEntry` are exported.
- When the account shares findings, the upload carries each finding (fingerprint, reviewer, severity, category, verification, file, lines, title, body, suggestion, quoted code), with secret-looking tokens redacted first and bounded to 200 findings, 4 KB per field and 256 KB in all.
- While the account shares findings, the repository hash uses the account's salt, kept in `account-salt` beside the credentials, so it matches on all of the account's machines.
- The counts sent to ocra Cloud after a review now include, per reviewer, its tasks, failed tasks, findings by severity, cost, and fixed and dismissed findings, plus the findings by verification and the run's fixed and dismissed totals. Still numbers only (ADR-0028).
- Your ocra Cloud account can turn on `ultra`: a signed-in review then runs as if `--ultra` were given, prints it among the settings it took from the account, and `--plan` lists it with its source.

### Changed

- An account setting that does not match the configuration's schema is now ignored alone, with a warning naming it, instead of all of them; unknown keys are ignored with one warning, and `providers`, `extends` and `github` from the account are always ignored. Account models must be `ocra-<provider>/<model>`.
- A failure to reach ocra Cloud for the settings is a warning, not an error.
- The account's default models fill each tier the configuration leaves empty, not only a configuration with no models at all.
- The pull request summary says how many findings the reviewing account's ocra Cloud memory hid, apart from those `.ocra/memory.json` hid.
- `ReviewReport.remembered` is now `RememberedEntry[]`: code that builds a `ReviewReport` itself sets each entry's `source`.

## [0.4.0] - 2026-10-04

ocra Cloud's first phase on the CLI side: sign in from the terminal, use the model keys stored in your account through its gateway, and see your reviews' counts on the web; nothing changes for a review that does not sign in. Also reasoning effort per tier, reviewer and role (ADR-0025). The Action's tag for this release is `jma49/Open-CR-Agent@v0.4.0`.

### Added

- `ocra login`, `ocra logout` and `ocra whoami` sign in to ocra Cloud (https://app.ocracloud.com, in development) with the OAuth device flow; `OCRA_CLOUD_URL` names another server and `OCRA_CLOUD=off` disables them.
- While signed in to ocra Cloud, models named `ocra-<provider>/<model>` go through its gateway with the key stored there.
- While signed in to ocra Cloud, a review sends its counts (never paths, finding text or code; the repository as a locally salted hash); `--no-upload` skips it.
- While signed in, a repository with no models configured uses the default models chosen on ocra Cloud.
- Reasoning effort per model tier (`effort`, `OCRA_EFFORT_<TIER>`), per reviewer (`reviewers.<id>.effort`) and per role (`roles.<verifier|judge|helper>.effort`), sent by the `direct` runtime as `reasoning_effort`, or `reasoning.effort` for a provider declared with `"effort": "openrouter"`; a call that sends an effort sends no temperature or seed, and an endpoint that refuses the parameter is asked again without it.
- The report's provenance lists each agent's tier, effort and whether it was applied (`provenance.agents`), and `ocra review --plan` shows each task's effort.
- `AgentTaskSpec.effort`, `CompletionRequest.agent` and `effort`, and the optional `AgentRuntime.appliedTo()` let a runtime plugin take the effort and say what it applied.

### Changed

- The project site moved to https://ocracloud.com (the old address redirects); package homepages and the SARIF tool link point there.

### Fixed

- The Action's `verdict` output is empty unless the review completed (exit code 0 or 1); a run that reviewed nothing used to output `approved`.
- The GitLab setup and the `--mr` error name a token that works on GitLab.com Free: a dedicated account's personal access token, since project access tokens need Premium there.

## [0.3.0] - 2026-10-03

ocra gets a second runtime that needs no OpenCode (`runtime: direct`), a library entry (`review()`) with a curated, recorded public API, SARIF import, run ids and `ocra metrics`, Action outputs, error codes, and reproducible evaluation. The curated API removes exports from every package's main entry: see Changed and Removed. The GitHub Action is `jma49/Open-CR-Agent@v0.3.0`.

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
- A JSON Schema for `.ocra/config.json`, `docs/schema/config.v1.json`; the file may name it in `$schema` so editors complete and check it.

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
- The container image runs `ocra` as its entrypoint (`docker run <image> review …`; the 0.2.0 form `docker run <image> ocra review …` still works). A GitLab job using the image sets `entrypoint: [""]`.

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

[Unreleased]: https://github.com/jma49/Open-CR-Agent/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/jma49/Open-CR-Agent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jma49/Open-CR-Agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jma49/Open-CR-Agent/releases/tag/v0.1.0
