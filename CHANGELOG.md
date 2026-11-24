# Changelog

All notable changes to the `@open-cr-agent/*` packages and the GitHub Action. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages, released together at one version, follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While that version is 0.x, a minor release may change options, configuration and output; each such change is listed here.

Entries come from the changesets in `.changeset/`, one per pull request that changes what users see; [.changeset/README.md](.changeset/README.md) says how to write one.

## [Unreleased]

## [0.27.0] - 2026-11-24

### Added

- `ocra init --github` also writes `.github/workflows/ocra-commands.yml`: `@ocra review` reviews a pull request again, and ocra answers any other `@ocra` mention in its thread.
- `"runtime": "codex"` reviews on the Codex CLI signed in on your computer, with models written `codex/default` or `codex/<model>`: each reviewer is one `codex exec` that reads the change only through ocra's tools, with Codex's own tools, configuration, rules and session history left out and no API key passed. Tokens are reported at $0.
- `providers.<id>.models.<model>.contextWindow`: the tokens one request to a model may hold, for a self-hosted model with a small window. The plan then holds a task's diff to a quarter of the smallest declared window, and the `direct` runtime ends a conversation before the request that would not fit, with the wrap-up turn, instead of failing on the endpoint's refusal. A prompt that cannot fit is not sent, and the next model of the chain takes the task.
- A task cut short this way ends as `context_window` in the JSON report (`ended`, next to `step_cap` and `stopped_early`) and in the review trace sent to ocra Cloud; the review is incomplete and says why.
- `ReviewLimits.contextWindow`, `ProviderModel` and `AttemptOutcome.atContextWindow` in `@open-cr-agent/core`, for embedders and runtime plugins.
- `ReviewerScope.focus`: path words on which a reviewer runs from a lower tier than its `minTier`.
- On GitHub, an `ocra review` check shows a review running on the pull request's head commit, then its verdict and findings when it ends. It never fails; the workflow needs `checks: write` to show it.
- `cloud.shareRepoName` in `.ocra/config.json` (off by default) names the repository in every upload to ocra Cloud, by path and normalised address.
- The review upload takes an optional `repo`: `name` and `url`, validated after normalising.

### Changed

- `ocra init` writes a workflow that pins the Action to v0.26.0.
- ocra's comment commands are spelled `@ocra review`, `@ocra override`, `@ocra dismiss` and `@ocra remember`, as ocra Cloud spells its own. A comment that gives a command is no longer answered as a question.
- The performance reviewer runs at the `lite` risk tier only on bundles with a file on a hot path (a path word such as cache, query, queue, pool, stream or cluster), and otherwise only at `full` (was every `lite` and `full` change). `reviewers.performance.minTier: "lite"` brings it back everywhere (ADR-0082).
- The summary comment counts findings once, naming only the severities found (for example "**1 warning** · risk tier `trivial`"), and no longer repeats the counts as its summary when the judge wrote none. `ocra review` in a terminal drops that repeated line too.

### Deprecated

- `/ocra review`, `/ocra override`, `/ocra dismiss` and `/ocra remember` still work and will be removed in a later release.

## [0.26.0] - 2026-11-24

### Added

- An account's rules take an optional `id`, as `.ocra/rules.json`'s do.
- A review uploaded with its findings carries the text of each rule they name, redacted and cut at 2,000 characters.

### Changed

- `ocra init` writes a workflow that pins the Action to v0.25.0.

## [0.25.0] - 2026-11-24

### Added

- `ocra learn check` lists the learnings whose paths match no file at HEAD, which reviews no longer give by path, and exits 1 when there is one
- Every review keeps its trace (ADR-0081): `.ocra/sessions/<id>/trace.json` and `report.trace` lay the run out in time (stages, each task's timed attempts, every plain model call with its model, each reported finding's fate and reason), with no code, prompt or answer text.
- The ocra Cloud upload carries the trace with the findings, redacted and bounded (`sharedTraceSchema`, `MAX_TRACE_*`).
- A `model_called` session event per plain completion; `CompletionResult.model` names the model that answered.

### Changed

- `ocra init` writes a workflow that pins the Action to v0.24.1.

## [0.24.1] - 2026-11-24

### Changed

- `ocra init` writes a workflow that pins the Action to v0.24.0.

### Fixed

- `ocra mend --conflicts` authors its merge commit on GitHub with the bot's `<id>+<login>` noreply address, so GitHub links it to the account, also on GitHub Enterprise Server.
- The comment after a merge round says it merged the base branch and gives `git revert -m 1` to undo it.

## [0.24.0] - 2026-11-24

A finding names the repository rule or learning it applies, so ocra Cloud can count findings per rule. The Action's new tag is `ocrahq/Open-CR-Agent@v0.24.0`.

### Added

- A finding names the repository rule or learning it applies in the report's `rule` (`{ kind, id }`) and in the Cloud upload; `.ocra/rules.json` rules take an optional `id`, and every rule's id is in the report's provenance (ADR-0080).

### Changed

- `ocra init` writes a workflow that pins the Action to v0.23.1.

## [0.23.1] - 2026-11-24

### Changed

- `ocra init` writes a workflow that pins the Action to v0.23.0.

### Fixed

- `ocra mend --checks` reads the last lines of the step that failed (GitHub Actions) or of the job's script (GitLab), not of the whole log, where steps that ran after the failure could push it out. `checkLogTail` in the contract does the same.
- Redaction keeps a file name that ends in a content hash and an extension (`assets/index-Bx92KqLm.js`) instead of replacing it.

## [0.23.0] - 2026-11-24

A proposed conflict of `ocra mend --conflicts` lists its regions with both sides, and the contract shares how a failed job's log is cut. The Action's new tag is `ocrahq/Open-CR-Agent@v0.23.0`.

### Added

- `checkLogTail` and `CHECK_LOG_LIMITS`: the end of a failed job's log as a round of `ocra mend --checks` reads it, so ocra Cloud shows the same text.
- `ocra mend --conflicts --level propose` lists each conflicted region with both sides and its answer (`regions` on a proposed conflict item), beside the whole resolved file.

### Changed

- `ocra init` writes a workflow that pins the Action to v0.22.0.

## [0.22.0] - 2026-11-24

`ocra mend` takes the head's failed checks (`--checks`) and the conflicts of merging the base branch (`--conflicts`) into the fix loop, and a round that commits leaves a note on the change request. The Action's new tag is `ocrahq/Open-CR-Agent@v0.22.0`.

### Added

- `ocra mend --conflicts` first resolves the conflicts of merging the base branch into the head of a pull or merge request: the fixer answers each conflicted region, code writes the file, and a verifier call checks it. All conflicted files are resolved or nothing is written.
- At `--level propose` each conflicted file's resolved content is in the result (`resolved`, with `mergeParent`); at `--level commit` the round pushes one merge commit from the local clone, never forced and never a rebase.
- The item reason `conflicts`, for findings that wait behind a conflict and for files left when the merge is not complete.
- `VcsAdapter.conflicts`, `ChangeConflicts`, `ConflictedFile` and `ChangeCommit.mergeParent` in `@open-cr-agent/core`; `ReviewPlatform.baseHead`, `pushTarget` and `MergeSource` in `@open-cr-agent/vcs-platform`.
- `ocra mend --checks` also works on the checks that failed on the head of a pull or merge request and do not fail on its base branch: at most 3 a round, each as a fixer task given the last 200 lines of the failed job's log as data. Nothing from the repository runs. `--findings` may be left out with it.
- `ocra mend` answers the outcome `waiting` when the head's checks are still running and nothing else is open; an item of its result names its `check`.
- `VcsAdapter.checks`, `ChangeChecks` and `FailedCheck` in `@open-cr-agent/core`, read by the GitHub and GitLab adapters; `ReviewPlatform.checks` and `failingOnBase` in `@open-cr-agent/vcs-platform`.
- A round of `ocra mend --level commit` leaves one comment on the pull or merge request with its commit: what it fixed, what it left and why, and the `git revert` that undoes it.
- `VcsAdapter.note` and `RoundNote` in `@open-cr-agent/core`.

### Changed

- `ocra init` writes a workflow that pins the Action to v0.21.0.

## [0.21.0] - 2026-11-24

`ocra mend` fixes findings that need more than a local edit through a fixer task with one `edit` tool, and a failed fix says what failed. The Action's new tag is `ocrahq/Open-CR-Agent@v0.21.0`.

### Added

- `ocra fix --json` and each item of `ocra mend --json` carry `cause` when the reason is `failed`: `timeout`, `quota`, `refused`, `unavailable`, `invalid_output` or `unknown`, never the endpoint's own message (`FIX_FAILURE_CAUSES` in `@open-cr-agent/cloud-contract`, `CALL_FAILURES` in `@open-cr-agent/core`).
- `ocra mend` fixes findings its local lane cannot place (code found more than once, a span over 30 lines, a fix that needs other lines or files) through a fixer task with the read tools and one `edit` tool over a copy of the head in memory, on the `direct` runtime; the gate and the verifier check its edits like any other.
- `AgentTaskSpec.toolset` (`TaskToolset`), `AgentRuntime.toolsets` and `readTools` in `@open-cr-agent/core`: a task's own tools in place of the review's, for a runtime that declares it runs them.

### Changed

- `ocra init` writes a workflow that pins the Action to v0.20.0.

### Fixed

- A learning file named after a long title ends at a whole word instead of mid-word.
- The pull request `ocra learn feedback --propose` opens says its learnings come from review feedback, since they are also drafted from declined findings.

## [0.20.0] - 2026-11-23

`ocra mend` runs one round of the fix loop over the findings a person accepted, `.ocra/rules.md` holds review rules in plain language, and `--depth` picks how thorough a review is. The Action's new tag is `ocrahq/Open-CR-Agent@v0.20.0`.

### Added

- `ocra mend` runs one round of the fix loop over accepted findings (`--findings`, `--level propose|commit`, `--state`, `--head`, `--protect`, `--json`): a checked fix each, a gate over what may be edited, one verifier call, then one unforced commit or the edits printed; it exits 3 when the head moved or the branch cannot be written to.
- `mendResultSchema`, `mendStateSchema`, `mendFindingsSchema` and the `MEND_*` vocabularies in `@open-cr-agent/cloud-contract`.
- `.ocra/rules.md`: review rules in plain language; a section whose heading names a path applies to files under it, every other section to every file.
- `@open-cr-agent/cloud-contract`: `RULES_MARKDOWN_PATH` and `MAX_RULES_MARKDOWN_CHARS`, so ocra Cloud checks the file as reviews read it.
- `depth` (`--depth`): `quick`, `standard` or `deep`, a preset of reviewers, effort, `ultra`, pre-existing findings and the inline floor that fills what the configuration leaves unset. ocra Cloud account settings take it too.

### Changed

- `ocra init` writes a workflow that pins the Action to v0.19.0.

## [0.19.0] - 2026-11-23

`ocra fix` writes a checked fix for one reported finding, inline comments can be limited by severity and number and read at a glance, and findings the direct runtime used to refuse for their arguments are kept. The packages' `repository` is `ocrahq/Open-CR-Agent`. The Action's new tag is `ocrahq/Open-CR-Agent@v0.19.0`.

### Added

- `ocra fix` writes a checked fix for one finding a review reported (`--finding`, `--head`, `--json`), prints it and commits nothing; it exits 3 when the finding's code is gone or the head moved.
- `fixResultSchema`, `FIX_OUTCOMES`, `FIX_REASONS` and `FIX_REJECTIONS` in `@open-cr-agent/cloud-contract`; a shared finding carries `lowConfidence`.
- `minInlineSeverity` and `maxInlineComments` (`--min-inline-severity`, `--max-inline-comments`) post fewer inline comments; the rest are listed in the summary and kept in the report (`inline` in the JSON report).
- `ultra` as a configuration key, and `--no-ultra` to turn off an `ultra` the configuration or the ocra Cloud account turns on.
- ocra Cloud account settings take `minInlineSeverity` and `maxInlineComments`.
- A shared finding carries its `evidence` to ocra Cloud (at most 5 one-line entries of 300 characters, redacted like its other text), so the web can show it as a pull request comment does; `MAX_EVIDENCE` and `MAX_EVIDENCE_FIELD` in `@open-cr-agent/cloud-contract`.

### Changed

- An inline comment on GitHub and GitLab opens with the finding's title on a line of its own, with its severity, reviewer and verification under it, names its fix **Suggested fix**, and folds the facts the reviewer checked under **Evidence**. A finding listed in the summary puts its title first and its text on the next line.
- The built-in reviewers word a finding to be read in a diff: a title of at most 12 words, a body of at most three sentences that opens with what goes wrong, code in backticks.
- Outside `--ultra`, a large bundle gets a plan call only for a reviewer with a task per bundle. The docs, guidelines, security and performance reviewers no longer plan first: those calls were about a tenth of a review's cost and changed no result.

### Fixed

- A finding whose evidence the reviewer sent as one string instead of a list is kept; it was refused and usually lost.
- A finding refused for its arguments in the same answer as `task_done` is no longer lost: the task goes on, so the reviewer reads the refusal and can report it again.
- The warning about a refused finding stays when the reviewer then reports a finding for another file; any accepted report used to clear it.
- A finding the direct runtime refused for its arguments and the reviewer did not send again is named in a warning of the report and in the task's progress line, with the fields that failed.

## [0.18.0] - 2026-11-23

A critical finding the verifier confirms is known while the review still runs, and the `direct` runtime reviews on endpoints that take no `tools` parameter. The Action's new tag is `ocrahq/Open-CR-Agent@v0.18.0`.

### Added

- `fetchFailure(error)` in `@open-cr-agent/core`: that message, for runtime plugins.
- Verify starts while review tasks still run: a file's findings are checked once every task reviewing it has ended, and a critical finding the verifier confirms is settled, so it is known before the review ends. `ocra review` prints a `Confirmed:` line for each, `ocra serve` and the live relay send it with `settled: true`, and core emits `findings_verified` ([ADR-0074](https://github.com/ocrahq/Open-CR-Agent/blob/main/docs/adr/0074-early-findings.md)).
- `ocra-eval perf` reports when the verifier answered for the first file, and takes `firstVerifiedMs` as a budget.
- The `direct` runtime reviews on a chat completions endpoint that takes no `tools` parameter (vLLM without a tool call parser, an Ollama model without a tool template): when the endpoint refuses the tools, the request goes again with the tools in the system prompt and the model's `<tool_call>` blocks run as calls. `providers.<id>.toolCalls: "text"` sends every request that way, for a gateway that drops the parameter silently.
- `textToolInstructions`, `parseTextToolCalls` and `textToolResults` in `@open-cr-agent/core`, and `CustomProvider.toolCalls`, for runtime plugins.

### Changed

- The Action runs ocra 0.17.0.
- The judge no longer merges a settled finding into another: two confirmed critical findings on different lines that it calls duplicates both stay in the report.
- On an endpoint that speaks Anthropic's Messages protocol, review tasks that start together no longer each pay to store the prompt start they share: the first stores it and the others wait until its answer begins, then read it from the provider's cache.
- The repository moved to `ocrahq/Open-CR-Agent`. `ocra init` writes the Action as `ocrahq/Open-CR-Agent@<commit>` and links there; workflows that name `jma49/Open-CR-Agent` keep working through GitHub's redirect. Container images from the next release on are `ghcr.io/ocrahq/ocra`; images up to 0.17.0 stay at `ghcr.io/jma49/ocra`.

### Fixed

- On the `direct` runtime a request that could not be sent names its cause instead of only `fetch failed`: the DNS, connection or TLS error, and for a certificate authority Node does not trust, that `NODE_EXTRA_CA_CERTS` fixes it.
- On the `opencode` runtime a turn that runs past its step cap is stopped and counts as one that used every step. OpenCode's cap only asks the model to stop, so a model that kept calling tools, or an endpoint that answered a streamed request without a stream, made requests until the task's timeout.

## [0.17.0] - 2026-11-23

`ocra learn feedback` turns the findings a pull request's reviewers declined into proposed learnings, and the security and performance reviewers need about a third fewer tasks on a change of many small bundles. The Action's new tag is `jma49/Open-CR-Agent@v0.17.0`.

### Added

- `ocra learn feedback --pr <n>` (or `--mr <iid>`) also drafts learnings from the findings of the pull or merge request's review that someone with write access declined in their thread, with what they said (`ChangeRequest.declined`).
- `ocra learn --config <file>` reads that configuration file instead of the repository's, as `ocra review` does.
- `MAX_QUOTA_WAIT_MS` in `@open-cr-agent/core`: the longest rate limit wait a run sits out, for runtime plugins that see a provider's stated wait.
- `ReviewerScope.span: "packed"`: the reviewer takes bundles that follow each other in run order in one task, up to the bundle size limits.

### Changed

- `ocra init` pins the Action to v0.16.0.
- The security and performance reviewers pack neighbouring bundles, keeping sensitive paths apart: a change of many small bundles needs about a third fewer review tasks and model requests.

### Fixed

- On the `opencode` runtime a task no longer waits out a long retry OpenCode holds a session in, such as a daily limit's wait until midnight: the session is stopped within seconds and the refusal counts as a quota limit, so the run moves on or stops as it does on `direct`.

## [0.16.0] - 2026-11-23

A large review needs fewer tasks and requests, runs eight tasks at once, keeps its progress through a rate limit, and on Anthropic's protocol reads more of its prompts from the cache. The Action's new tag is `jma49/Open-CR-Agent@v0.16.0`.

### Added

- `RateLimits`, handed to `ModelAttempts.task`: a runtime plugin's attempt can wait a rate limit out with `waitOut(quota)` and send its request again.
- `ReviewerScope.span`: a reviewer with `span: "change"` reviews the change as a whole, in as few tasks as its size allows, instead of once per bundle.

### Changed

- `ocra init` pins the Action to v0.15.0.
- A review on the `opencode` runtime sends one model request fewer per task: the done tool ends the session, and its result is no longer sent back to the model. A review of 20 files in 41 tasks sent 193 requests and 2.34 million input tokens instead of 234 and 2.91 million; findings are the same ([#699](https://github.com/jma49/Open-CR-Agent/pull/699)).
- A task's plan call is asked as its reviewer and shares the start of the task's prompt, so on Anthropic's protocol the task reads its files from the prompt cache instead of storing them again. `CompletionRequest.sharedPrefixes` is new.
- Eight review tasks run at once by default instead of four (`concurrency`): a review of more than four tasks takes up to 42% less time where the provider's rate limit allows it (measured on changes of 26 and 49 tasks), with the same tasks and prompts; a small change of four tasks or fewer takes as long as before. Set `concurrency` to 4 for the old pace.
- On the `direct` runtime a rate limit no longer costs a task its progress: the refused request waits for the model's pause and is sent again, where the task used to start over and ask for every step a second time.
- The docs and agents-md reviewers review the change as a whole: one task each, or a few for a change of more than 20 files or 120,000 characters of diff. A large change needs about a third fewer review tasks and reaches the task limit later.

## [0.15.0] - 2026-11-23

A review on an `anthropic` provider sends fewer tokens and pays less for the ones it repeats, and a review that reviewed nothing says why instead of passing. The Action's new tag is `jma49/Open-CR-Agent@v0.15.0`.

### Changed

- On an Anthropic Messages endpoint, a single-request call (a plan phase, Verify, Judge, grouping) no longer stores its prompt in the provider's prompt cache. Nothing read it back, and storing costs a quarter more than sending.
- Generated migration metadata is no longer reviewed: Drizzle's `meta/` snapshots and journal, Prisma's `migration_lock.toml`, EF Core's `*.Designer.cs` and model snapshot; nor are the lock files of Deno, NuGet, SwiftPM, CocoaPods, pub, Mix and Gradle. `include` brings a file back.
- On an `anthropic` provider, review tasks read the start of the prompt they share from the prompt cache instead of each storing it (`AgentTaskSpec.sharedPrefixes`).

### Fixed

- `configSchema.safeParse` returns an issue at the provider's or tracker's address when that address is not a URL, instead of throwing a `TypeError`; ocra reports such a `.ocra/config.json` as invalid instead of crashing.
- A review that reviewed nothing no longer uploads the verdict `approved` to ocra Cloud; it uploads none.
- "Nothing was reviewed" now says why: the model provider refused every call (a daily limit or a rate limit), or the first task error. The JSON report's failed tasks carry `quota` when every model they could use was out of quota.

## [0.14.0] - 2026-11-23

### Added

- A model through ocra Cloud is priced as ocra Cloud lists it, so the reported cost and `--max-cost-usd` count it; a model it lists no price for stays unpriced, with a warning naming it.
- `@open-cr-agent/cloud-contract` exports `modelPriceSchema`, and a provider entry carries `prices`.

### Changed

- `ocra init` pins the Action to v0.13.0.

## [0.13.0] - 2026-11-23

### Added

- The contract exports `configSchema`, the Zod schema `.ocra/config.json` is checked against, with its refinements (endpoints, credential variable names, unique check ids, providers' models), and `configJsonSchema()`.
- A provider declared with `"type": "anthropic"` runs on the direct runtime through Anthropic's Messages API, with the prompt cache at every step and the effort as `output_config.effort`.
- `ocra-<provider>/<model>` reaches an ocra Cloud provider that lists only a Messages endpoint, such as `ocra-anthropic/<model>`.
- `guidelineScope` (`--guidelines`): give each review task every section of `AGENTS.md` (`all`, the default), the sections for its files (`matched`), or give them only to the `agents-md` reviewer (`reviewer`).
- The review upload's `outcomes` can carry `fixedFingerprints` and `dismissedFingerprints`, at most 200 each; a signed-in review sends them when the account shares findings, so ocra Cloud can mark which earlier findings a re-review saw fixed or dismissed.

### Changed

- `ocra init` pins the Action to v0.12.0 by its commit.
- `AGENTS.md` longer than 20,000 characters is no longer cut mid-section: sections that do not fit are left out whole and listed by heading.
- Code search on a large repository costs less: one `git grep` runs at a time, shared by the searches that wait for it and stopped once each has its matches, and the `direct` runtime runs the tool calls of one step together. A review of 398 files in a repository of 32,000 took 64 s instead of 99 s with a model that answers at once; results are the same ([#695](https://github.com/jma49/Open-CR-Agent/pull/695)).

### Fixed

- A call to ocra Cloud that could not be sent names its network or certificate error instead of only `fetch failed`, and says to use `NODE_EXTRA_CA_CERTS` for a server whose certificate authority Node does not trust.
- `ocra review --pr` on GitHub Enterprise Server finds the repository from an `origin` on the server `GITHUB_API_URL` names, without `--repo`.

## [0.12.0] - 2026-11-22

`ocra review --fixes` proposes fixes, each checked against the reviewed head, `--without` measures what each context source is worth, and every context source has a bound. The Action's new tag is `jma49/Open-CR-Agent@v0.12.0`.

### Added

- ocra Cloud account settings may turn linked tasks off (`linkedTasks`), where the configuration leaves it out.
- `fixes: true` or `ocra review --fixes` proposes a fix for findings a local edit fixes, one `fixer` call per file, each kept only if it applies to the reviewed head, touches only the finding's lines and still parses; the report's `fixes` says why one was not kept (ADR-0058).
- `ReviewOptions.syntax` and `treeSitterSyntax()` check that a fix leaves its file parsing.
- ocra Cloud account settings can turn fixes on (`fixes` in the review settings).
- `ocra-eval run --fixes`, with fix counts in the golden summary.
- `ocra review --without <sources>` (`ReviewMode.without`) leaves context sources out of every review prompt, to measure what each is worth.
- `ocra review --plan --format json` gives each task's first prompt by source: tokens, cuts and duplicated lines (`context`).

### Changed

- `ocra init` pins the Action to v0.11.0.
- The judge's call counts toward the spend limit.
- Review prompts hold the changed-files list to 150 files, accepted findings to the last 20 on the bundle's files, the repository's rules to 12,000 characters, and task and learning titles to 300 characters; smaller inputs render as before.

### Fixed

- `ocra review --mr` reads the project from an HTTPS `origin` of a GitLab installed under a relative URL root (`CI_API_V4_URL` such as `https://example.com/gitlab/api/v4`).
- The Action finds npm's sigstore client where Homebrew and similar installs keep npm, away from the Node binary, so it fetches the trusted root before checking signatures there too.
- A tree-sitter parse cut off by its time budget no longer carries over into the next file's symbols.

## [0.11.0] - 2026-11-22

`ocra generate` writes tests and doc comments onto a pull request, `ocra stack` keeps stacks of pull and merge requests, `ocra mcp` lets coding agents call a review, pre-merge checks in plain words get a verdict, and reviewers see the issues and tracker tasks a change is linked to. The Action's new tag is `jma49/Open-CR-Agent@v0.11.0`.

### Added

- `ocra generate tests` and `ocra generate docstrings` write one commit on a pull or merge request's branch: new test files beside the changed sources, or doc comments inserted in the changed lines, one writer call per file (at most 5); `--dry-run` prints the edits as a diff, `--json` prints the outcome, and a moved or fork branch exits 3 without a commit.
- `VcsAdapter.commit` and `VcsAdapter.listFiles`, and the GitHub and GitLab adapters' commit on the change request's branch, made only on top of the head ocra read.
- `@open-cr-agent/cloud-contract` describes `ocra generate --json`'s line: `generateResultSchema`, `GENERATE_KINDS`, `GENERATE_OUTCOMES` and `MAX_GENERATED_FILES`.
- Reviewers of a pull or merge request see the issues it closes, or the issue its branch is named after: at most 3, cut to fixed sizes, from the reviewed repository only. The report's `linkedTasks` lists them; `linkedTasks: false` or `--no-linked-tasks` turns it off.
- `VcsAdapter.linkedTasks()` and the `LinkedTask` record for adapters that can link tasks.
- A signed-in review whose ocra Cloud account shares findings relays its progress to ocra Cloud as it runs and prints where to watch it, so the run can be shared with others to watch and comment on; best effort, never slowing the review, and off with `--no-upload`.
- `@open-cr-agent/cloud-contract`: `liveBatchSchema`, `liveAnswerSchema`, `LIVE_EVENTS_PATH` and the live relay's limits.
- `ocra mcp`: a Model Context Protocol server on standard input and output with one `review` tool, so a coding agent such as Claude Code, Cursor or Codex can review its changes with ocra; its arguments only narrow the review, as `ocra serve`'s do, and its answer marks the findings as untrusted data.
- `mergeChecks` in configuration: pre-merge checks in plain words, each judged against the change with a reason, in the summary comment and the report's `mergeChecks`.
- `ReviewOptions.mergeChecks` for embedders.
- A pull or merge request review's upload carries each check's outcome (its reason when the account shares findings) and the ids of the learnings its tasks were given.
- The contract exports `mergeCheckSchema`, `sharedMergeCheckSchema` and `LEARNING_PROPOSAL_BRANCH`.
- `projectDocs` in configuration: the sections of the team's design documents that name a bundle's files are given to its review tasks, and the report's `projectDocs` lists them.
- `ReviewOptions.projectDocs` for embedders.
- A pull or merge request review's upload names its linked issues (tracker, number, address, state), with their titles and labels when the account shares findings.
- `ocra stack` keeps a stack of pull or merge requests: `create`, `track`, `log`, `restack`, `submit` and `sync`, on GitHub and GitLab.
- `githubStackHost` and `gitlabStackHost`, over the `StackHost` port in `vcs-platform`.
- `trackers` in configuration: Jira and TAPD tasks a pull or merge request names by key (title, description or branch) are read through the team's MCP server and given to the reviewers with the linked issues.
- `ReviewOptions.taskSources` and `ChangeRequest.branch` for embedders.

### Changed

- `ocra init` pins the Action to v0.10.0.
- Workflows written by `ocra init` and the manual's recipes grant `issues: read`.
- Review tasks on files under sensitive paths (`auth/`, CI workflows and the like) start first, so a run stopped by the spend or task limit has reviewed those files; `--plan` lists tasks in that order, and task ids are unchanged.

### Fixed

- The local adapter's `listFiles` lists the repository's root directory instead of nothing.
- The Action no longer fails now and then with "1 package has an invalid attestation": it fetches sigstore's trusted root once before `npm audit signatures` verifies the packages in parallel.

## [0.10.0] - 2026-11-22

A walkthrough of the change in the summary, `@ocra` questions answered in their thread, and `/ocra review` to review a pull request again. The Action's new tag is `jma49/Open-CR-Agent@v0.10.0`.

### Added

- The Action reviews the pull request a comment is on when run on `issue_comment`, in full; the manual's workflow runs it on `/ocra review` from someone with write access.
- A walkthrough of the change in the summary comment of pull and merge request reviews: an overview, the files grouped in reading order and a sequence diagram when the flow crosses three or more components; the `walkthrough` setting turns it off, or on for local reviews, and the JSON report carries it.
- A review shared with ocra Cloud carries its walkthrough, redacted like the findings, when the account shares findings (`walkthrough` in the upload contract).
- The `writer` role, which writes the walkthrough on the standard tier; `roles.writer` sets its models and effort.
- `ocra graph --cloud` starts from the code graph a self-hosted ocra Cloud server keeps of the repository, and parses only the files changed since; without one it builds the graph locally.
- `@open-cr-agent/cloud-contract` describes the server's code graph listing: `graphRepoSchema`, `graphReposAnswerSchema`, `CODE_PLATFORMS`, `GRAPH_BUILD_STATES`, `GRAPH_COMMIT_HEADER` and `MAX_GRAPH_REPOS`.
- `ocra reply` answers a comment that mentions `@ocra` on a GitHub pull request or GitLab merge request, in its thread, for people with write access, once per comment; `--config` names ocra's account as for a review.
- The Action's `reply` input runs it on `issue_comment` and `pull_request_review_comment`.
- `VcsAdapter.mention`, and the `Mention` and `MentionRef` types.
- A shared finding carries its fix (`fix`: the lines it replaces and the replacement) when the account shares findings, sent only as written, so ocra Cloud can commit it to the pull request.

### Changed

- `ocra init` pins the Action to v0.9.0.
- When more learnings apply to a bundle than fit, those whose symbol or keyword is in the function or class the change touches rank first; `--plan` shows the same learnings as the run.
- With `--sarif-evidence`, a result tagged `security` goes only to the security reviewer of its file, or to every reviewer when none reviews it.

### Fixed

- Learning paths read like `.gitignore`: `*.sql` and `Dockerfile` match at any depth, `dir/` matches what is under it, a leading `/` anchors to the root, and case is ignored.
- A learning's compound symbol matches in any naming convention (`createCharge`, `create_charge`) and member access written `?.`, `->` or `::`; keywords match plurals and Chinese or Japanese text without spaces.
- A learning whose symbol the change uses is no longer crowded out by learnings that only share its path.
- `ocra learn` gives a learning drafted from a fix that moved a file both the old and the new directory.

### Security

- Require `undici` 8.12.4 and `@modelcontextprotocol/sdk` 1.32.2.

## [0.9.0] - 2026-11-21

The first release on npm since 0.7.0: 0.8.0 was never published, so this release also carries its changes below. The Action's new tag is `jma49/Open-CR-Agent@v0.9.0`.

### Added

- The Action's `learn` input (`mine` or `remember`) drafts learnings and opens them as a pull request, with a `proposal` output; with the workflow's own token the pull request is left for a person to merge.
- `ocra learn --propose --require-review` leaves the pull or merge request for a person whatever `learnings.requireReview` says.
- The GitHub Action keeps ocra's symbol cache in the Actions cache between runs (`symbol-cache`, on by default) and drops entries no run read for 30 days; reading a cached entry now touches it.
- `updateGraph` builds the symbols of every file of a revision from a tree listing, parsing only files the previous graph lacks; `graphReferences` answers a review's callers from it, and `serializeGraph` / `parseGraph` store it in a versioned, deterministic format.
- `ocra learn feedback` drafts learnings from the findings the team accepted in `.ocra/memory.json`, with the reason it gave (ADR-0040).
- `ocra learn import <file.md>...` drafts learnings from each `##` section of the team's documents that names files of the repository (ADR-0040).
- `ocra learn --propose` opens a GitLab merge request that merges when its pipeline succeeds; `--repo` or `--project` names where it opens.
- `proposeOnGitLab` in `@open-cr-agent/vcs-gitlab`, and an optional `sleep` in `ProposeOptions`.
- `ocra learn mine --propose` opens the kept learnings as a GitHub pull request, set to merge once its checks pass; `learnings.requireReview: true` in `.ocra/config.json` leaves it for a person (ADR-0040).
- `proposeOnGitHub` (`vcs-github`) and the `FileProposal` and `ProposedChange` types (`vcs-platform`).
- `/ocra remember <note>` on a pull or merge request, from someone with write access, and `ocra learn remember --pr <n>` (or `--mr <iid>`) to draft learnings from those notes (ADR-0040).
- `ChangeRequest.remember`: the notes, as the platform adapters read them.
- `ocra graph --out <file> [--rev <commit>]` writes the code graph of a commit, and updates an existing one by parsing only the files it lacks.
- `ocra review --graph <file>` takes the callers of changed symbols from that graph, after `--scip` and before searching.
- `ocra review --sarif-evidence <file>` shows the reviewers an analyzer's SARIF results on and near the change as evidence to confirm, not as findings; the report's `analyzerEvidence` lists what each tool contributed.

### Changed

- Files at a revision are read through one long-lived `git cat-file --batch-command` (git 2.36 or later) instead of a process per file.
- `ocra learn` skips what a learning on origin's `ocra/learnings-*` proposal branches records, so a proposal waiting for review, or one closed without merging, is not drafted again; `--propose` names its files apart from theirs, so two proposals never conflict.
- A run renders its list of changed files once for all its tasks and checks each path against the access policy once; a scripted review of 669 files spent a fifth less time.

### Fixed

- `ocra serve` writes its address and token file in one rename, so a client that finds the file never reads it empty or half written.

## [0.8.0] - 2026-11-21

### Added

- `ocra learn mine` drafts learnings for `.ocra/learnings/` from the fix commits on HEAD's first-parent line: one helper call per fix, kept only when not a duplicate and selected for its own fix, written to the working tree (ADR-0040).
- The review learning file format: `learningFrontmatterSchema`, `splitLearning`, `learningIdOf` and their limits (ADR-0037).
- `ocra review` reads the team's learnings from `.ocra/learnings/*.md` at the trusted revision (the base commit for `--pr` and `--mr`) and gives each task those that apply; a file that is not a valid learning is skipped with a warning (ADR-0037).
- `ReviewOptions.learnings`: each review task is given the team's learnings that apply to its files, selected without a model, and the report lists them under `learnings` (ADR-0037).
- Learnings that apply past the per-task budget are listed by id and title (up to 10), and reviewers read one with the new `read_learning` tool (`ReviewContext.readLearning`).
- `ocra serve`: a review service on 127.0.0.1 that starts reviews over HTTP and streams each one's events (Server-Sent Events, the contract's `reviewEventSchema`); cancel is its only mid-run command.
- `AppliedSettings.unsentBecause`: why a runtime sent no reasoning effort when the cause is not the capability table. `AttemptOutcome.unreadMessages`: how many of a session's messages a runtime could not read.
- `showPreExisting` (default `true`) in `.ocra/config.json`, and `stages.showPreExisting` in `ReviewOptions`: `false` leaves findings Verify traced to code from before the change out of the report.
- Review events `stage_started` (each stage, in order), `coverage_settled` (each file's last state, before Verify) and `usage_reported` (every model call's spend, adding up to the run's usage).
- The live review event schema (`reviewEventSchema`, version 1) that `ocra serve` will stream and ocra Cloud will relay, with `readReviewEvent`, which skips kinds a newer engine adds, and a fixture of one run's events.
- A review agent that ends without `task_done` (at the step cap, or after stopping early) gets one more turn, with only `report_finding` and `task_done`, to report what it has already confirmed; the report's task records it as `wrapUp`, next to its `ended`, and its files still count as partly reviewed (`incomplete`), since the turn reads nothing more ([#469](https://github.com/jma49/Open-CR-Agent/issues/469)).
- Runtime SPI: `ModelAttempts.task` may return a `TaskAttempt` whose `wrapUp()` continues the attempt's conversation; `WRAP_UP_MESSAGE`, `WRAP_UP_TOOLS` and `WRAP_UP_STEPS` describe the turn.
- `isIncompleteReview(report)` and `isBlocking(report)` in `@open-cr-agent/core`: the rules the CLI's exit codes 3 and 1 apply, for embedders to gate on.
- `ocra review --scip <file>`: callers of changed symbols come from a SCIP index first, exactly as it resolved them; symbols it does not know are searched for as before.
- `ReviewOptions.references` takes a `ReferenceIndex`; `scipReferences` in `@open-cr-agent/code-graph` reads one from a SCIP file.
- `@open-cr-agent/code-graph`: definitions and uses per file with tree-sitter (TypeScript, JavaScript, Python, Go, Rust, Java), cached by git blob id.
- `ReviewOptions.symbols` takes a `SymbolExtractor` for the impact analysis.
- A signed-in `--pr` or `--mr` review names the pull or merge request in its upload to ocra Cloud: the repository's address, the number and the head commit.
- `@open-cr-agent/cloud-contract` exports `normaliseRemote` and `REPOSITORY_URL`; the upload schema takes `pullRequest`.
- Verify is shown where the names in each finding's quoted code are defined and used elsewhere in the repository, so it can settle claims about callers, types and guards.
- A finding Verify traces to code the change did not bring in is marked `preExisting` in the JSON report and "pre-existing" in review comments; the verdict is unchanged.

### Changed

- Code searches asked in the same turn (the callers of a bundle's symbols, the code around Verify's findings, an agent's parallel tool calls) share one `git grep` of the reviewed revision; a scripted review of 669 files ran in half the time.
- Review tasks at the `full` risk tier are shown the callers of the symbols their bundle changes, as under `--ultra`, without its plan phase or second sample.
- `ocra whoami` says whether this machine sends findings to ocra Cloud.
- Checking whether your ocra Cloud account remembers any finding asks for one entry only.
- `isBlocking` takes the change request's `override` as typed by `ChangeRequest`, and `PreviewOptions` no longer accepts `full`, which `mode.full` already sets.
- The workflows `ocra init --github` writes pin the Action to v0.7.0.
- The judge sees each finding's quoted code and its verification, so it merges duplicates by the lines they quote and never drops a confirmed finding as speculative.
- A finding a reviewer reports on another changed file, outside its bundle, is kept (once, by fingerprint) instead of dropped; only findings on files outside the review are dropped.
- The `finding_dropped` session event's reason is now `outside_review` (was `outside_bundle`).
- A pre-existing finding never counts towards the verdict, so it cannot block a change.
- The live event stages no longer list `anchor`, which is part of the review stage.
- Callers count a symbol as changed when any line of its body changes, list only uses in code with the function or class they sit in, and put changed signatures first. The CLI caches what it parses in `~/.cache/ocra/symbols/` (`$OCRA_CACHE_DIR`).

### Fixed

- The warning when ocra cannot remove an old ocra Cloud account salt no longer says it could not keep the salt.
- A signed-in review whose config directory cannot be written runs anyway: it warns, uses the account's salt it was just sent, and sends nothing to ocra Cloud only when no salt can be had.
- On `opencode`, a run longer than about 50 minutes on `ocra-` models no longer renews the ocra Cloud token at every start when a new token would last no longer.
- Checking whether your ocra Cloud account remembers findings reads no more than it needs, and every ocra Cloud answer is read up to a size limit.
- The ocra Cloud session and the salts are flushed to disk before they replace the old file, and on Windows the replacement is tried again while another program holds the file a moment.
- The warning about a model priced at 0 also covers a chain that only your ocra Cloud account's settings name; it checked the configuration before the account's settings joined it.
- A plugin package whose `exports` name an entry for `import` only loads, from the repository's dependencies and from your ocra Cloud account; a package with both entries now loads its `import` entry.
- On Windows, a process that tried to take the ocra Cloud credentials' lock just as another process's lock was being removed could carry on without it, so two runs could refresh the session at once. It now takes the lock.
- On Windows, an empty `credentials.json.lock.<hex>.probe` file left in the config directory by an ocra process killed at the wrong moment is removed by a later run once it is older than a stale lock.
- On the `opencode` runtime, when OpenCode's model catalog cannot be read at start, the effort warning now gives that cause instead of saying the capability table knows no way to send the level.
- On the `opencode` runtime, one session message in an unexpected shape no longer drops the attempt's findings and usage: it is skipped and counted in the attempt's progress line.
- `ocra review --plan` with `--pr` or `--mr` plans what the review would cover: only what changed since the previous review when ocra can tell, as the review does, with the scope in the text and in the plan JSON's new optional `scope`; it used to plan a full review the run would not make.
- The first Ctrl-C of a pull or merge request review no longer waits out a GitHub or GitLab rate-limit pause before stopping.
- A request GitHub or GitLab refuses has at most 64 KB of its answer read, instead of all of it; the error still quotes its first 500 characters.
- The GitHub and GitLab clients take an abort signal that also ends the wait before a retry (up to 60 seconds on a rate limit), not only the request in flight.
- `OCRA_RECORD_DIR` recordings leave out a key renewed during the run and a key with a quote or backslash.
- A recording that cannot be written is a warning; the model request is no longer sent again.
- Redaction replaces a flag's secret argument followed by `;`, `,` or `)`, as in a shell command line.
- Model exchange recordings leave out the key a request was sent with when the key is renewed before the answer arrives.
- The review summary and the pull request summary no longer count memory entries without a source as hidden by your ocra Cloud memory.
- A session key or upload salt ocra cannot read (owned by another user, say, after `sudo ocra`) is no longer replaced: the review warns, and sends nothing to ocra Cloud when it needed that salt.
- `--resume` on a session whose log is empty says the log is empty.
- `--output` refuses, before any model call, a path that exists but is not a regular file (a named pipe, a device), as it refuses links such as `/dev/stdout`; it leaves no temporary file when ocra exits before the rename.
- `review()` refuses invalid `limits` (a concurrency that is not a whole number of at least 1, a timeout that is not positive, a negative or `NaN` spend limit, a fractional task cap) with `CONFIG_INVALID` before it starts; `concurrency: NaN` used to start no task and crash, and a negative timeout threw from inside the run.
- `ocra metrics` counts a run with a critical finding it could not verify as incomplete, as the run's exit code 3 does; it counted only runs with unfinished files.
- A working tree review lists each directory once per run instead of once per file read, which cost about 0.4 s per read in a directory of 100,000 entries.
- A working tree review reads a file under a directory whose name is stored decomposed on disk (as on macOS) by the precomposed name git reports.

### Security

- The Action's outputs (`verdict`, `run-id`, `findings`, `report`) come from the session the run wrote, never from a session that came with the pull request, and are not read through a symbolic link.
- A signed-in review sends findings and their code only when this machine agreed: `ocra login` records that when the account shares findings, and a review that finds sharing off forgets it. After turning sharing on in ocra Cloud, run `ocra login` again on each machine.
- The account's `exclude` applies only when your configuration sets none, so a repository that lists its own exclusions (even `[]`) cannot have files hidden from review by its ocra Cloud account.
- `GATEWAY_PATH` refuses `.`, `..` and empty segments, so a gateway path ocra Cloud lists stays under its provider.
- `ocra metrics --format json` escapes C1 and bidirectional control characters from session data, as the other JSON outputs already did.
- Prompt neutralization also catches tags spelled with any default-ignorable or format character, more look-alike brackets and letters, and fullwidth, mathematical and other compatibility forms, and a `<` that ends a field, so two fields cannot form a tag where they meet.
- The redaction pass for shared findings also replaces a secret value in a JSON string whose quotes are escaped, the lines of a YAML block scalar (`password: |`), the argument after a flag such as `--password` or `--api-key`, a password glued to `mysql -p`, a quoted value cut by a line break, a `Bearer` or `Basic` credential on the next line, and a lowercase `bearer` or `basic` credential of 16 or more characters with a digit.
- Require undici 8.12.3 or later, which fixes high-severity advisories in 8.0.0–8.12.1 (GHSA-xjj6-f33q-929c).
- Range, commit and pull request reviews read `.gitattributes` from the base commit (git 2.41 or later), so the reviewed change cannot mark its own files binary to keep them from review.
- A file whose name says text but that was skipped as binary gets a warning.
- git runs with only the environment variables it needs: model keys and platform tokens no longer reach it, except the tokens credential helpers read when ocra fetches a pull request's commits.
- Require zod 4.6.6 or later, which no longer exhausts memory validating oversized constrained collections (GHSA-mrhx-c7xc-m3w5).

## [0.7.0] - 2026-10-09

Security hardening from the 2026-10-09 audit: model text in comments is neutralized from a CommonMark parse, secret paths are refused under Unicode case folding, `--resume` reuses only sessions sealed on this machine, `--output` no longer follows links, and redaction runs in linear time and covers more secret forms. Reliability for busy and shared setups: a burst of rate limits costs one wait, tasks that finish at the spend limit are kept, and concurrent processes take turns renewing the ocra Cloud session. This release also brings `ocra init` and `ocra review --resume`; the Action's tag for it is `jma49/Open-CR-Agent@v0.7.0`.

### Added

- `ocra init` writes `.ocra/config.json` for the model key in the environment (Gemini, Anthropic and OpenAI on the default OpenCode runtime, OpenRouter's free router `openrouter/free` on the direct runtime, with a note that free requests are few without credits), and with `--github` the fork-safe GitHub workflow (`--same-repo-only` for the plain `pull_request` one); a file that exists is kept unless `--force` is given.
- `ocra review --resume <run-id>` reuses the completed tasks of an earlier run whose inputs and commits are unchanged and runs only the rest, taking reused tasks before the spend limit; `ReviewOptions.resume` does the same for embedders. `tasks[].reusedFrom` in the JSON report names the run that paid for a reused task, and `ocra metrics` and the ocra Cloud upload count its cost there, not in the run that reused it.
- Review events: `task_reported` (a completed task's findings and the key of its inputs) and `groups` on `files_bundled` (each bundle's files). An exhaustive `switch` over `ReviewEvent` needs the new case.
- The session log (`events.jsonl`) records, on each attempt's summary line, the files the reviewer read, what it searched for and its final text (`attempt`), so a missed issue can be traced to a file it never opened or one it read and passed over, and each finding dropped because it names a file outside its task's bundle (`finding_dropped`); the report is unchanged. Runtimes report exploration through `exploredBy()`.
- `OCRA_RECORD_DIR`: the direct runtime writes every model request and the answers it got to that directory (keys redacted, owner-only files), so a run can be read afterwards or replayed in tests without a model.
- The JSON report's `tasks[].ended` (`step_cap` or `stopped_early`) and coverage status `incomplete` with `ended`; `coverageGaps()` counts them in `incomplete`, and `isUnfinished()` tells which coverage entries the next review includes; a runtime marks an attempt whose last turn used every step with `AttemptOutcome.atStepCap`.
- `redactField()` in `@open-cr-agent/cloud-contract`: one shared finding field cut at `MAX_FIELD`, then redacted, as the CLI sends it.

### Changed

- The summary comment credits dismissals to maintainers ("Dismissed by maintainers"), since "reviewer" names ocra's review agents.
- A review task whose reviewer ran out of steps, or stopped, before it called the done tool no longer counts its files as reviewed: they are `incomplete` (partly reviewed) in coverage, the run exits `3`, the message says what to do, and the pull or merge request summary lists them ([#477](https://github.com/jma49/Open-CR-Agent/issues/477)).
- `sharedFindingSchema` holds `title` and `body` to `MAX_FIELD` characters (a finding with a longer one is left out) and reads a longer `category`, `suggestion` or `code` as absent.

### Fixed

- Rate limits that reach a model while it is paused, as when tasks running at once are refused together, count as that pause: one burst no longer drops the model for the run, and a task that waited one out no longer sends a request to a model another task found out of quota in the meantime.
- A rate limit that states no wait, as Vertex AI's shared quota sends when busy, pauses the model for 15, 30, then 60 seconds instead of dropping it for the run; a limit that says "per-day" (OpenRouter's free models) counts as a daily limit.
- With `--max-cost-usd`, a review task whose last spend report reaches the review share after the agent finished counts as completed, not cancelled: its files no longer count as unfinished, exit with `3`, and get reviewed again on the next push.
- Concurrent ocra processes no longer renew the ocra Cloud session with the same refresh token: a process waits out another's renewal (up to two and a half minutes, saying so after five seconds) instead of giving up after 10 seconds, the lock of a process that died is broken (at once when its process has exited) by one process only, a renewal never saves over a session saved meanwhile, and `ocra login` and `ocra logout` wait for a renewal in progress. On Windows, a lock still being removed is waited for too, instead of carried on without. Two renewals with one token could leave a superseded token saved and end the session at its next use.
- On `"runtime": "direct"`, a gateway token that could not be renewed before it expired is still renewed once ocra Cloud answers again, instead of failing every later model call through ocra Cloud for the rest of the run.
- The direct runtime now works with Gemini behind an OpenAI-compatible endpoint, such as Vertex AI's: a tool call goes back to the model with its `type` and with the thought signature Gemini attached (`extra_content`). Before, the second request of every review task was refused with HTTP 400.
- In the GitHub guide's fork-safe workflow (and the one `ocra init --github` writes), a run the job's `if:` skips (an unrelated label, an outside author's push) no longer cancels the review in progress: the concurrency group, now on the review job, repeats the condition, so such a run gets a group of its own. The guide's plain `pull_request` workflow skips pull requests from forks, which get no secrets there, instead of failing their check. A workflow copied from an earlier guide keeps both problems: change it as the guide shows.
- On a Windows runner the Action starts npm without a shell, so a runner directory holding `&` or `^` no longer breaks its install step.
- On Windows, a git command that exits before reading all of its input no longer fails the local review with `write EOF`. Its exit code decides the outcome, as on Linux and macOS.
- The published packages no longer end their files with `sourceMappingURL` comments naming maps they do not ship, so bundlers that load ocra's packages stop warning "Failed to load source map".

### Security

- Model text in pull request and merge request comments is neutralized from a CommonMark parse, so it can no longer post HTML, images, links or mentions by making ocra and the platform disagree on what is code, nor a GitLab wikilink or a committable suggestion of its own (#509).
- Secret-looking paths, files renamed away from them and `.git/` are refused under any spelling a case-insensitive file system opens as the same name, Unicode case variants and invisible characters included, not only under ASCII case variants.
- Workspace reviews read a file only under its own name: on a case-insensitive file system, such as macOS's by default, another spelling of the name no longer opens it.
- `ocra review --resume` reuses only what ocra on this machine wrote: each session line is sealed with a key of the user's kept in `~/.config/ocra/session-key`, and a session without valid seals (another machine, another user, or one that came with the change) is refused. The session log is read without following links, as a regular file, within 64 MiB; bundles come from the sealed log, not `report.json`. `sessionJsonlPlugin` takes an optional `sealKey` setting that seals each line it writes.
- `ocra review --output` no longer writes through a symbolic link: a link at the output path, or at a directory on the way inside the repository, is refused with `ACCESS_DENIED` (exit `2`) before any model call, and the file is replaced whole in one rename.
- Reading a JSON report (`ocra metrics`, `ocra memory`) refuses anything but a regular file and stops at 64 MiB.
- `redact()` takes time linear in its input; crafted text no longer stalls it, and the CLI cuts each field to 4 KB before redacting it ([#515](https://github.com/jma49/Open-CR-Agent/issues/515)).
- Shared findings are redacted of more secret forms: unquoted `password: …` and `NAME=…` values, `curl -u user:…`, short `Bearer` and `Basic` credentials, PGP private key blocks, and hex tokens after a prefix such as `dop_v1_` ([#513](https://github.com/jma49/Open-CR-Agent/issues/513)).
- The GitHub guide's recipes, and the workflows `ocra init --github` writes, pin every action by commit, like the Action, so a moved tag cannot change what runs with the workflow's secrets. A workflow copied from an earlier guide keeps the tags: pin them as the guide shows.
- `@modelcontextprotocol/sdk` is at 1.31.0 or later (GHSA-6qxp-vccf-f47h). ocra's tool server does not use the SDK's OAuth client, which the advisory concerns.

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

[Unreleased]: https://github.com/jma49/Open-CR-Agent/compare/v0.27.0...HEAD
[0.27.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.24.1...v0.25.0
[0.24.1]: https://github.com/jma49/Open-CR-Agent/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.23.1...v0.24.0
[0.23.1]: https://github.com/jma49/Open-CR-Agent/compare/v0.23.0...v0.23.1
[0.23.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jma49/Open-CR-Agent/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/jma49/Open-CR-Agent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jma49/Open-CR-Agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jma49/Open-CR-Agent/releases/tag/v0.1.0
