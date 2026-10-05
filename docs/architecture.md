# Architecture

Open-CR-Agent (`ocra`) reviews code changes with a pipeline of deterministic stages that surround a small number of LLM-driven steps. It combines two proven designs:

- **Cloudflare AI Code Review** ([blog](https://blog.cloudflare.com/ai-code-review/)): plugin architecture, domain-specialised reviewers with explicit "what not to flag" rules, a top-tier coordinator that judges and deduplicates, risk tiering, model failback with circuit breakers, incremental re-review.

- **Alibaba OpenCodeReview** ([repo](https://github.com/alibaba/open-code-review)): deterministic file selection, semantic file bundling, per-file-type rule matching, plan → multi-round review → fact-check filter, snippet-based comment anchoring, coverage manifests and resumable sessions.

Sections below describe the target design. Anything marked **(planned)** is not implemented yet; the user manual describes only what exists.

The two split work along different axes: Cloudflare by **review domain**, OCR by **file bundle**. `ocra` uses both, and a deterministic **Review Matrix Planner** decides which reviewer runs on which bundle so cost does not grow as bundles × reviewers.

## Principles

1. **Engineering for what must not fail, agents for judgment.** Selection, bundling, rule resolution, anchoring and publishing are code. LLMs plan, investigate, report and judge.
2. **Precision first.** A false positive costs reviewer trust. The default mode favors precision; `--ultra` trades cost for recall.
3. **Negative constraints are first-class.** Every reviewer prompt states what it must not flag.
4. **Everything is a plugin.** No VCS, model provider or agent runtime is hard-coded.
5. **Measured, not guessed.** Prompt, rule and stage changes are evaluated against a benchmark before merge.

## Pipeline

```
 Ingest → Select → Triage → Bundle → Matrix → Execute → Anchor → Filter → Verify → Judge → Publish
 └─────────── deterministic ─────────────┘   └─ LLM ─┘  └ code ┘  └ code ┘  └ LLM ┘  └ LLM ┘  └ code ┘
                         Session store: JSONL events · coverage manifest · finding fingerprints
```

| # | Stage | Kind | Responsibility |
|---|---|---|---|
| 1 | Ingest | code | Load the change set and metadata through a `VcsAdapter` (GitHub PR or local working tree). |
| 2 | Select | code | Pure function that decides per file: review, or exclude with a reason (binary, secret path, user rule, extension, generated/vendored/lock file, too large). Migrations are never excluded as generated. |
| 3 | Triage | code | Assign a risk tier (`trivial` / `lite` / `full`) from churn, file count and sensitive paths. Sensitive paths always force `full`. |
| 4 | Bundle | code + cheap LLM | Group related files into review units. Small change sets are bundled without an LLM; larger ones are grouped by an LLM that answers with file indices; oversized bundles fall back to per-file. |
| 5 | Matrix | code | Choose reviewers per bundle from tier, file kinds, paths and rules, and resolve the rule text for each (bundle, reviewer) cell. |
| 6 | Execute | LLM agents | Run each cell as an isolated agent task via `AgentRuntime`: read-only tools, findings submitted through the `report_finding` tool. A plan phase and a second review round are **(planned)**. Results of external analyzers (SARIF logs passed with `--import-sarif`) join here as synthetic tasks on the change (ADR-0019). |
| 7 | Anchor | code | Resolve each finding's `existingCode` snippet to exact lines by normalized matching in hunks, then full files, then other files' hunks (exact and unique only); otherwise a file-level comment. A partial-line quote must be at least `MIN_PARTIAL_QUOTE_CHARS` (12) long and fit one line; several equally good matches are ambiguous and stay file-level, counted in `report.anchoring`. The LLM never supplies line numbers. Before the file-level fallback, a light model re-locates the quote from the finding and the file's diff (`anchor/relocate.ts`); its answer is matched like any quote. |
| 8 | Filter | code | Drop findings in the repository's memory and those a reviewer dismissed, and compare with the previous review (Re-review), before any money is spent checking them. |
| 9 | Verify | LLM | Fact-check each finding against the diff. Only findings the diff proves wrong are dropped; the rest are marked confirmed, uncertain or unchecked. |
| 10 | Judge | top-tier LLM | Coordinator deduplicates across reviewers, recalibrates severity, filters speculation and nitpicks, and writes the summary. The verdict itself is code (`judge/verdict.ts`) over the judged findings. |
| 11 | Publish | code | Post one summary comment plus inline comments, apply the verdict, update threads from the previous review. |

In core, `reviewWithHooks` (`pipeline/run.ts`) only sequences them: `planReview` (stages 1–4), `executeStage` (5–7, `pipeline/execute-stage.ts`, one `runJob` per cell), `filterStage` (8), `checkStage` (9–10), then `assembleReport`. Each stage returns its own warnings and usage, and the report lists them in stage order; the spend tracker and the run's signal are the only state they share.

Core's modules form layers with no import cycle, type imports included: `contracts.ts` (the runtime contract) and `domain.ts` at the bottom; `agent/` above them (what every model call shares: an agent's settings, JSON answers, the spend tracker, bounded concurrency, usage sums); the stages (`select/`, `bundle/`, `review/`, `verify/`, `judge/`, `anchor/`, …) above that, depending only downwards; `report/` above the stages whose results it records (the report, its published output and schema, provenance); and `pipeline/` on top, orchestrating them. The published `ReportOutput` type is derived from `reportOutputSchema`, and `toReportOutput` copies domain values into it field by field, so a field added to a domain type never reaches the JSON report by accident. `vcs.ts` holds `VcsAdapter`, which publishes the report and so sits above it.

## Reviewers

| Reviewer | Scope | Default model tier |
|---|---|---|
| `correctness` | Logic errors, broken contracts, error handling | standard |
| `security` | Exploitable or concretely dangerous issues only | standard |
| `performance` | Measurable regressions on hot paths | standard |
| `docs` | Public API and user-facing documentation drift | light |
| `agents-md` | Material changes that should update `AGENTS.md` (runs only when the repository has one) | light |

Reviewers are plugins; teams can add their own (for example, compliance with internal standards).

Model tiers are configurable. Defaults: **top** for Judge, **standard** for code reviewers and Verify, **light** for grouping (and, when implemented, re-location and text-heavy reviewers).

## Finding model

```ts
Finding {
  id, fingerprint,            // fingerprint = hash(category + file + normalized existingCode)
  reviewer, category,         // category is always the reviewer's, never the model's
  provenance: { task, model? },  // the task in report.tasks (its reviewer, files, outcome, usage); the model when the runtime names it
  severity: 'critical' | 'warning' | 'suggestion',
  file, existingCode, lineRange?,  // lineRange is computed by Anchor, never by the LLM
  title, body, suggestion?, evidence[],
  quote?: { lines, hash },    // normalized anchored lines, to tell later whether the code is still there
  verification?: 'confirmed' | 'uncertain' | 'unchecked',  // set by Verify
  status: 'new' | 'unfixed'    // fixed and dismissed earlier findings: report.rereview
}
```

The published form is the JSON report (`toReportOutput`, `"version": 1`), described by a Zod schema that generates `docs/schema/report.v1.json` (`npm run schema`); a test keeps the file, the schema and the output together. ADR-0018 is the specification.

## Verdict rubric

| Condition | Verdict |
|---|---|
| No findings | `approved` |
| Suggestions, or fewer than three warnings | `approved_with_comments` |
| Three or more warnings, or critical findings Verify did not confirm | `minor_issues` |
| Any critical finding Verify confirmed | `significant_concerns` (blocks) |

The rubric is biased toward approval. Findings carry `verification: confirmed | uncertain | unchecked` from Verify (refuted ones are dropped); unchecked covers a skipped or failed check and carries over with earlier findings. The judge may neither drop nor downgrade a confirmed critical finding. Every model reads attacker-controlled text, so the verdict is advice, not a security gate. A "break glass" override exists for pull requests: `/ocra override <full commit id> <reason>`, in a comment nobody else edited, from someone the repository grants write access other than the author, lets that commit pass (exit 0) and withdraws a request for changes, while the verdict stays.

## Re-review

Findings carry fingerprints, so a re-review can compare against the previous run (ADR-0009):

- Reported again → `unfixed`, the existing thread is kept and not commented again.
- Fixed → only when the anchored code is gone from the file at head (hash of its normalized lines) or the file was deleted; listed and its thread resolved.
- Not reported again but the code is unchanged → `notReproduced`; its file not reviewed this time → `notRechecked`. Both stay open, keep their severity in the verdict and their thread.
- Resolved by a reviewer, or declined with `/ocra dismiss` or a reply opening with "won't fix", "by design", "false positive" and the like, by someone with write access other than the author, in a comment nobody else edited → dismissed, quiet unless it comes back more severe.
- Any other reply (for example "I disagree") from someone with write access other than the author, in a comment no one else edited, is shown to the Judge whenever that finding is reported again, even after an earlier run dropped it, so the outcome does not flip between runs. The judge may drop the finding when a reply gives a specific reason, never a confirmed critical one.
- Incremental (ADR-0010): the state records the head it reviewed and the files it did not finish. When that head is an ancestor of the new one and ocra was the last to edit its summary, only files changed since then plus the unfinished ones are reviewed; other files are `unchanged` and their findings carry over. Otherwise, or with `--full`, everything is reviewed and the report says why.

`reconcile` is pure; the pipeline reads the earlier findings' files beforehand and passes whether each one's code is still present.

## Modes

| | Default (precision) | `--ultra` (recall) |
|---|---|---|
| Reviewers | By tier and matrix | All, every bundle |
| Plan phase | Large bundles only (≥5 files or ≥40,000 diff characters) | Always: one short call per task, its checklist added to the prompt |
| Sampling | One run per cell | Two runs per cell, merged |
| Impact analysis | Off | Callers of changed symbols searched (definition patterns, `code_search`, outside the bundle) |
| Judge threshold | Strict | Relaxed; extra findings marked low confidence |

All of it is implemented.

## Contracts

```ts
interface VcsAdapter {            // one instance per change request
  getChangeRequest(): Promise<ChangeRequest>
  getDiff(): Promise<FileDiff[]>
  readFile(path): Promise<string | undefined>   // file content at head
  searchCode(literal): Promise<CodeMatch[]>
  getPriorReview(): Promise<PriorReview | undefined>  // earlier findings, and what changed since
  publish(report: ReviewReport): Promise<{ warnings: string[] }>
}

interface AgentRuntime {
  runTask(spec: AgentTaskSpec, signal: AbortSignal): AsyncIterable<AgentEvent>
}
```

Both are contributed by plugins (ADR-0006):

```ts
interface OcraPlugin {
  name: string
  settingsSchema?: ZodType                       // validates pluginSettings.<name>
  bootstrap?(ctx): Promise<void>                 // concurrent, failures warn
  configure?(ctx: ConfigureContext): void        // ordered, failures abort
  postConfigure?(ctx): void                      // sees the frozen registry
}
// ConfigureContext: registerVcs, registerRuntime, registerReviewer, registerRules, registerTool, onEvent
```

The pipeline owns orchestration. `AgentRuntime` only executes one isolated agent task, so the runtime can be swapped: `runtime-opencode` (OpenCode, ADR-0003) and `runtime-direct` (declared OpenAI-compatible endpoints, ADR-0020), both held to the runtime conformance suite. Neither implements failback: each gives core's `ChainRunner` single-model attempts (`ModelAttempts`), and the runner resolves the call's chain, keeps model health and fails over, the same way for both and for a third-party runtime built on it. The runner also decides when a review attempt that ended without `task_done` gets its wrap-up turn (one more turn with only the reporting tools); the runtime only continues its own conversation (`TaskAttempt.wrapUp`). What else a runtime needs (the review tools, the step cap, quota parsing, redaction) is public in core too; neither runtime imports `@open-cr-agent/core/internal`.

## Resilience

- Per-task timeout, whole-run timeout, and a periodic "model is thinking" heartbeat. Inactivity detection ends a task early when its session has not changed for five minutes (`session-prompt.ts`); the task fails over to the next model.
- Circuit breaker per model (closed → open → half-open probe, cooldown doubling up to a limit). Any model error except a credential error fails over to the next model in the tier's chain. A rate limit with a short stated wait pauses that model for every task and retries it; a daily limit, a long or missing wait, or repeated limits take the model out of the chain for the rest of the run.
- A failed task never fails the run; it is recorded in the coverage manifest.
- A spend limit keeps a reserve: review tasks stop starting at 80% of it (`REVIEW_BUDGET_SHARE`), Verify and Judge use the rest, and findings left unchecked when it runs out cannot block. Tasks run in plan order, so a limited run finishes whole files and a pull request's next review continues with the rest; tasks the limit never started leave their files unreviewed, and the report says the limit was reached (`spendLimit`, ADR-0015).
- A review task finishes when its agent calls the done tool. Core reads each attempt's ending from what it reports; a task that ended at the step cap or stopped early leaves its files `incomplete`, and the run exits 3 (ADR-0030).

## Packages

```
packages/
  core/              domain types, stages, contracts
  runtime-opencode/  AgentRuntime on @opencode-ai/sdk
  runtime-direct/    AgentRuntime over declared OpenAI-compatible endpoints (ADR-0020)
  vcs-platform/      the review conversation every platform shares (ADR-0016)
  vcs-github/        VcsAdapter for GitHub, over vcs-platform
  vcs-gitlab/        VcsAdapter for GitLab merge requests, over vcs-platform
  vcs-local/         VcsAdapter for the local git repository
  cloud-contract/    the wire contract with ocra Cloud: schemas, limits, redaction
  cli/               `ocra` command
  eval/              AACR-Bench replay, precision / recall / F1 / cost
```

Each published package has a curated main entry, its public API: named exports only, recorded in `etc/<package>.api.md` by API Extractor and checked in CI (`npm run check:api`), so a change to it shows in review. What the packages share with each other beyond that goes through a `./internal` subpath export (`@open-cr-agent/core/internal` and others), which is not a contract and may change in any release. The manual's Embedding and Stability pages say which entries are a contract. `npm run check:packages` lints every packed tarball with publint and attw (ESM only) before it installs them.

Inside `cli/src`, `run.ts` dispatches to one module per command, `commands/<name>.ts` (the review command's parts in `commands/review/`: `reviewCommand` runs `resolveRun`, then `planRun` or `executeRun`, `writeReport`, `deliver` (publish, upload) and `exitCode`), over shared modules that never import a command: `io/` (output, terminal sanitising, `UsageError`, the `EXIT` codes), `config/`, `cloud/` (ocra Cloud credentials, session, calls), `plugins/` and `session/` (the session store). Argument parsers are named `parse*`, functions that turn arguments into a review target `resolve*`.

## Roadmap

| Milestone | Scope |
|---|---|
| M1 | CLI on local diffs · Select, Bundle, Anchor · one `correctness` reviewer · eval harness running |
| M2 | Multiple reviewers · Matrix planner · Verify and Judge · risk tiers |
| M3 | GitHub Action · inline comments and verdicts · incremental re-review |
| M4 | Failback and circuit breakers · remote config · long-term review memory · `--ultra` |

M1–M4 are built. What comes next, and why, is in [roadmap.md](roadmap.md).
