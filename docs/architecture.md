# Architecture

Open-CR-Agent (`ocra`) reviews code changes with a pipeline of deterministic stages around a few LLM-driven steps. It combines [Cloudflare AI Code Review](https://blog.cloudflare.com/ai-code-review/) (domain reviewers with "what not to flag" rules, a judging coordinator, risk tiers, model failback, incremental re-review) and [Alibaba OpenCodeReview](https://github.com/alibaba/open-code-review) (deterministic selection, semantic bundling, per-file-type rules, a fact-check filter, snippet anchoring, coverage manifests). One splits work by **review domain**, the other by **file bundle**; ocra does both, and a deterministic **Review Matrix Planner** (ADR-0007) decides which reviewer runs on which bundle, so cost does not grow as bundles × reviewers.

This page is for contributors; anything marked **(planned)** is not implemented. The [user manual](manual/en/index.mdx) describes only what exists, and the [ADRs](adr/README.md) record why.

## Principles

1. **Engineering for what must not fail, agents for judgment.** Selection, bundling, rule resolution, anchoring and publishing are code. LLMs plan, investigate, report and judge.
2. **Precision first** (ADR-0004). The default favors precision; `--ultra` trades cost for recall.
3. **Negative constraints are first-class.** Every reviewer prompt states what it must not flag.
4. **Everything is a plugin.** No VCS, model provider or agent runtime is hard-coded.
5. **Measured, not guessed.** Prompt, rule and stage changes are evaluated before merge.

## Pipeline

```
 Ingest → Select → Triage → Bundle → Matrix → Execute → Anchor → Filter → Verify → Judge → Publish
 └─────────── deterministic ─────────────┘   └─ LLM ─┘  └ code ┘  └ code ┘  └ LLM ┘  └ LLM ┘  └ code ┘
                         Session store: JSONL events · coverage manifest · finding fingerprints
```

| # | Stage | Kind | Responsibility |
|---|---|---|---|
| 1 | Ingest | code | Load the change set and metadata through a `VcsAdapter`. |
| 2 | Select | code | Pure function: review each file, or exclude it with a reason (binary, secret path, user rule, extension, generated/vendored/lock file, too large). Migrations are never excluded as generated. |
| 3 | Triage | code | Risk tier (`trivial` / `lite` / `full`) from churn, file count and sensitive paths; sensitive paths force `full`. |
| 4 | Bundle | code + cheap LLM | Group related files. Small change sets without an LLM; larger ones by an LLM answering with file indices; oversized bundles fall back to per-file. |
| 5 | Matrix | code | Choose reviewers per bundle from tier, file kinds, paths and rules, and resolve each (bundle, reviewer) cell's rule text. |
| 6 | Execute | LLM agents | Run each cell as an isolated agent task via `AgentRuntime`, with read-only tools; findings go through `report_finding`. A second review round is **(planned)**. SARIF logs from `--import-sarif` join here as synthetic tasks (ADR-0019). |
| 7 | Anchor | code | Resolve each finding's `existingCode` to lines by normalized matching in hunks, then full files, then other files' hunks (exact and unique only); a partial-line quote needs `MIN_PARTIAL_QUOTE_CHARS` (12). Before the file-level fallback, a light model re-locates the quote (`anchor/relocate.ts`). Models never supply line numbers. |
| 8 | Filter | code | Drop remembered and dismissed findings and compare with the previous review, before spending on checks. |
| 9 | Verify | LLM | Fact-check each finding against the diff. Only findings the diff proves wrong are dropped; the rest are confirmed, uncertain or unchecked. |
| 10 | Judge | top-tier LLM | Deduplicate across reviewers, recalibrate severity, filter speculation and nitpicks, write the summary. The verdict is code (`judge/verdict.ts`). |
| 11 | Publish | code | Summary and inline comments, the verdict, earlier threads updated. |

`reviewWithHooks` (`pipeline/run.ts`) only sequences them: `planReview` (1–4), `executeStage` (5–7, one `runJob` per cell), `filterStage` (8), `checkStage` (9–10), then `assembleReport`. Each stage returns its own warnings and usage, listed in stage order in the report; the spend tracker and the run's signal are the only shared state.

Core's modules form layers, type imports included, and no two directories import each other: `contracts.ts`, `domain.ts` and the utilities; `agent/` (what every model call shares); the stages (`select/`, `bundle/`, `review/`, `matrix/`, `verify/`, `judge/`, `anchor/`, …); `report/`; what reads a report (`rereview/`, and `vcs.ts`, whose `VcsAdapter` publishes it); `pipeline/`; then `session/`, `plugin/` and `runtime/`, which plug into a run. `core/src/layers.test.ts` holds the map and fails on an import that goes up a layer or closes a cycle. `ReportOutput` is derived from `reportOutputSchema`, and `toReportOutput` copies domain values field by field, so a domain field never reaches the JSON report by accident.

## Reviewers

| Reviewer | Scope | Default tier |
|---|---|---|
| `correctness` | Logic errors, broken contracts, error handling | standard |
| `security` | Exploitable or concretely dangerous issues only | standard |
| `performance` | Measurable regressions on hot paths | standard |
| `docs` | Public API and user-facing documentation drift | light |
| `agents-md` | Changes that should update `AGENTS.md` (only when the repository has one) | light |

Reviewers are plugins. Model tiers are configurable; defaults are **top** for Judge, **standard** for code reviewers and Verify, **light** for grouping, re-location and text-heavy reviewers.

## Finding model

```ts
Finding {
  id, fingerprint,            // fingerprint = hash(category + file + normalized existingCode)
  reviewer, category,         // category is always the reviewer's, never the model's
  provenance: { task, model? },  // the task in report.tasks; the model when the runtime names it
  severity: 'critical' | 'warning' | 'suggestion',
  file, existingCode, lineRange?,  // lineRange is computed by Anchor, never by the LLM
  title, body, suggestion?, evidence[],
  quote?: { lines, hash },    // normalized anchored lines, to tell later whether the code is still there
  fix?: { startLine, endLine, replacement },  // a committable suggestion (ADR-0029); no stage sets it yet
  verification?: 'confirmed' | 'uncertain' | 'unchecked',  // set by Verify
  status: 'new' | 'unfixed'    // fixed and dismissed earlier findings: report.rereview
}
```

The published form is the JSON report (`"version": 1`), whose Zod schema generates `docs/schema/report.v1.json` (`npm run schema`); a test keeps them together. ADR-0018 is the specification.

## Verdict

| Condition | Verdict |
|---|---|
| No findings | `approved` |
| Suggestions, or fewer than three warnings | `approved_with_comments` |
| Three or more warnings, or critical findings Verify did not confirm | `minor_issues` |
| Any critical finding Verify confirmed | `significant_concerns` (blocks) |

The rubric leans toward approval. The judge may neither drop nor downgrade a confirmed critical finding. Every model reads attacker-controlled text, so the verdict is advice, not a security gate; the `/ocra override` command (in the manual) lets a commit pass while the verdict stays.

## Re-review

Fingerprints let a re-review compare with the previous run (ADR-0009, ADR-0010); the manual describes the outcomes users see.

- Reported again → `unfixed`, its thread kept. Fixed → only when the anchored code is gone at head (its quote hash) or the file was deleted. Not reported but the code is unchanged → `notReproduced`; its file not reviewed this time → `notRechecked`; both stay open and count in the verdict.
- Dismissals and replies count only from someone with write access other than the author, in a comment nobody else edited (`vcs-platform`, ADR-0016). A dismissal stays quiet unless the finding returns more severe; any other reply is shown to the Judge whenever the finding is reported again, so the outcome does not flip between runs; the judge may drop it for a specific reason, never a confirmed critical one.
- Incremental: when the reviewed head is an ancestor of the new one and ocra last edited its summary, only files changed since, plus unfinished ones, are reviewed; the rest are `unchanged` and their findings carry over. Otherwise, or with `--full`, everything is reviewed.

`reconcile` is pure; the pipeline reads the earlier findings' files beforehand and passes whether each one's code is still present.

## Modes

| | Default (precision) | `--ultra` (recall) |
|---|---|---|
| Reviewers | By tier and matrix | All, every bundle |
| Plan phase | Large bundles only (≥5 files or ≥40,000 diff characters) | Always: one short call per task, its checklist added to the prompt |
| Sampling | One run per cell | Two runs per cell, merged |
| Impact analysis | Off | Callers of changed symbols searched outside the bundle |
| Judge threshold | Strict | Relaxed; extra findings marked low confidence |

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

The pipeline owns orchestration; a runtime executes one isolated task. `runtime-opencode` (ADR-0003) and `runtime-direct` (ADR-0020) both pass the runtime conformance suite. Neither implements failback: each gives core's `ChainRunner` single-model attempts (`ModelAttempts`), and the runner handles chains, model health and failover for any runtime. The rest a runtime needs (review tools, step cap, quota parsing, redaction) is public in core; neither runtime imports `core/internal`.

## Resilience

- Per-task and whole-run timeouts; a task whose session is idle for five minutes fails over (`session-prompt.ts`).
- A circuit breaker per model (closed → open → half-open, cooldown doubling to a limit). Any error but a credential error fails over to the next model in the chain. A short stated rate-limit wait pauses that model for every task; a daily limit, a long or missing wait, or repeated limits remove it for the run.
- A failed task never fails the run; it is recorded in the coverage manifest.
- The spend limit keeps a reserve: review tasks stop starting at 80% (`REVIEW_BUDGET_SHARE`), Verify and Judge use the rest, and findings left unchecked cannot block. Tasks run in plan order, so a limited run finishes whole files and the next review continues; the report says the limit was reached (`spendLimit`, ADR-0015).
- A review task finishes when its agent calls the done tool; one that ended at the step cap or stopped early leaves its files `incomplete`, and the run exits 3 (ADR-0030).

## Packages

```
packages/
  core/              domain types, stages, contracts
  runtime-opencode/  AgentRuntime on @opencode-ai/sdk
  runtime-direct/    AgentRuntime over declared OpenAI-compatible endpoints
  vcs-platform/      the review conversation every platform shares
  vcs-github/        VcsAdapter for GitHub, over vcs-platform
  vcs-gitlab/        VcsAdapter for GitLab merge requests, over vcs-platform
  vcs-local/         VcsAdapter for the local git repository
  cloud-contract/    the wire contract with ocra Cloud: schemas, limits, redaction
  cli/               `ocra` command
  eval/              AACR-Bench and golden replay, precision / recall / cost
```

Each published package's main entry is its public API, recorded in `etc/<package>.api.md` (`npm run check:api`); `./internal` subpaths are not a contract (see `AGENTS.md` and the manual's Stability page). `npm run check:packages` lints the packed tarballs with publint and attw.

In `cli/src`, `run.ts` dispatches to one module per command, `commands/<name>.ts`. The review command lives in `commands/review/`: `reviewCommand` runs `resolveRun`, then `planRun` or `executeRun`, `writeReport`, `deliver` (publish, upload) and `exitCode`. Shared modules never import a command: `io/` (output, terminal sanitising, `UsageError`, the `EXIT` codes), `config/`, `cloud/`, `plugins/` and `session/`. Argument parsers are named `parse*`; functions that turn arguments into a review target, `resolve*`.

## Milestones

M1 (CLI on local diffs, Select, Bundle, Anchor, one reviewer, the eval harness), M2 (reviewers, Matrix, Verify and Judge, risk tiers), M3 (the GitHub Action, inline comments, verdicts, incremental re-review) and M4 (failback, remote config, review memory, `--ultra`) are built. What comes next is in the [roadmap](roadmap.md).
