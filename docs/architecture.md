# Architecture

Open-CR-Agent (`ocra`) reviews code changes with a pipeline of deterministic stages that surround a small number of LLM-driven steps. It combines two proven designs:

- **Cloudflare AI Code Review** ([blog](https://blog.cloudflare.com/ai-code-review/)): plugin architecture, domain-specialised reviewers with explicit "what not to flag" rules, a top-tier coordinator that judges and deduplicates, risk tiering, model failback with circuit breakers, incremental re-review.
- **Alibaba OpenCodeReview** ([repo](https://github.com/alibaba/open-code-review)): deterministic file selection, semantic file bundling, per-file-type rule matching, plan → multi-round review → fact-check filter, snippet-based comment anchoring, coverage manifests and resumable sessions.

The two split work along different axes: Cloudflare by **review domain**, OCR by **file bundle**. `ocra` uses both, and a deterministic **Review Matrix Planner** decides which reviewer runs on which bundle so cost does not grow as bundles × reviewers.

## Principles

1. **Engineering for what must not fail, agents for judgment.** Selection, bundling, rule resolution, anchoring and publishing are code. LLMs plan, investigate, report and judge.
2. **Precision first.** A false positive costs reviewer trust. The default mode favors precision; `--ultra` trades cost for recall.
3. **Negative constraints are first-class.** Every reviewer prompt states what it must not flag.
4. **Everything is a plugin.** No VCS, model provider or agent runtime is hard-coded.
5. **Measured, not guessed.** Prompt, rule and stage changes are evaluated against a benchmark before merge.

## Pipeline

```
 Ingest → Select → Triage → Bundle → Matrix → Execute → Anchor → Verify → Judge → Publish
 └─────────── deterministic ─────────────┘   └─ LLM ─┘  └ code ┘  └ LLM ┘  └ LLM ┘  └ code ┘
                         Session store: JSONL events · coverage manifest · finding fingerprints
```

| # | Stage | Kind | Responsibility |
|---|---|---|---|
| 1 | Ingest | code | Load the change set and metadata through a `VcsAdapter` (GitHub PR or local working tree). |
| 2 | Select | code | Pure function that decides per file: review, or exclude with a reason (binary, secret path, user rule, extension, generated/vendored/lock file, too large). Migrations are always kept. |
| 3 | Triage | code | Assign a risk tier (`trivial` / `lite` / `full`) from churn, file count and sensitive paths. Sensitive paths always force `full`. |
| 4 | Bundle | code + cheap LLM | Group related files into review units. Small change sets are bundled without an LLM; larger ones are grouped by an LLM that answers with file indices; oversized bundles fall back to per-file. |
| 5 | Matrix | code | Choose reviewers per bundle from tier, file kinds, paths and rules, and resolve the rule text for each (bundle, reviewer) cell. |
| 6 | Execute | LLM agents | Run each cell as an isolated agent task via `AgentRuntime`: optional plan, up to two review rounds, read-only tools, findings submitted through the `report_finding` tool. |
| 7 | Anchor | code + cheap LLM | Resolve each finding's `existingCode` snippet to exact lines by normalized matching in hunks, then full files; fall back to LLM re-location, then to a file-level comment. The LLM never supplies line numbers. |
| 8 | Verify | LLM | Fact-check each finding against the diff. Only findings the diff proves wrong are dropped. |
| 9 | Judge | top-tier LLM | Coordinator deduplicates across reviewers, recalibrates severity, filters speculation and nitpicks, and decides the verdict. |
| 10 | Publish | code | Post one summary comment plus inline comments, apply the verdict, update threads from the previous review. |

## Reviewers

| Reviewer | Scope | Default model tier |
|---|---|---|
| `correctness` | Logic errors, broken contracts, error handling | standard |
| `security` | Exploitable or concretely dangerous issues only | standard |
| `performance` | Measurable regressions on hot paths | standard |
| `docs` | Public API and user-facing documentation drift | light |
| `agents-md` | Material changes that should update `AGENTS.md` | light |

Reviewers are plugins; teams can add their own (for example, compliance with internal standards).

Model tiers are configurable. Defaults: **top** for Judge, **standard** for code reviewers, **light** for grouping, re-location and text-heavy reviewers.

## Finding model

```ts
Finding {
  id, fingerprint,            // fingerprint = hash(category + file + normalized existingCode)
  reviewer, category,
  severity: 'critical' | 'warning' | 'suggestion',
  file, existingCode, lineRange?,  // lineRange is computed by Anchor, never by the LLM
  title, body, suggestion?, evidence[],
  status: 'new' | 'unfixed' | 'fixed' | 'dismissed'
}
```

## Verdict rubric

| Condition | Verdict |
|---|---|
| No findings or only trivial suggestions | `approved` |
| Suggestions, or warnings without production risk | `approved_with_comments` |
| Several warnings forming a pattern | `minor_issues` |
| Any critical finding or production risk | `significant_concerns` (blocks) |

The rubric is biased toward approval. A "break glass" override forces approval and is recorded.

## Re-review

Findings carry fingerprints, so a re-review can compare against the previous run:

- Fixed → omitted and its thread resolved.
- Still present → re-emitted to keep the thread alive.
- Resolved by a human → respected unless it materially worsened.
- Human replies "won't fix" / "acknowledged" → resolved; "I disagree" → reassessed by Judge.

## Modes

| | Default (precision) | `--ultra` (recall) |
|---|---|---|
| Reviewers | By tier and matrix | All, every bundle |
| Plan phase | Skipped for small bundles | Always |
| Sampling | One run per cell | Two runs per cell, merged |
| Impact analysis | Off | Callers of changed symbols searched |
| Judge threshold | Strict | Relaxed; extra findings marked low confidence |

## Contracts

```ts
interface VcsAdapter {
  getChangeRequest(ref): Promise<ChangeRequest>
  getDiff(ref): Promise<FileDiff[]>
  getPriorReview(ref): Promise<PriorReview | undefined>
  publish(ref, result: ReviewResult): Promise<void>
}

interface AgentRuntime {
  runTask(spec: AgentTaskSpec, signal: AbortSignal): AsyncIterable<AgentEvent>
}
```

The pipeline owns orchestration. `AgentRuntime` only executes one isolated agent task, so the runtime can be swapped (OpenCode today, see ADR-0003).

## Resilience

- Per-task timeout, whole-run timeout, inactivity detection, and a periodic "model is thinking" heartbeat.
- Circuit breaker per model family (healthy → open → half-open probe). Only retryable errors (429, 503) trigger failback, and only within the same family.
- A failed task never fails the run; it is recorded in the coverage manifest.

## Packages

```
packages/
  core/              domain types, stages, contracts
  runtime-opencode/  AgentRuntime on @opencode-ai/sdk
  vcs-github/        VcsAdapter for GitHub
  cli/               `ocra` command
  eval/              AACR-Bench replay, precision / recall / F1 / cost
```

## Roadmap

| Milestone | Scope |
|---|---|
| M1 | CLI on local diffs · Select, Bundle, Anchor · one `correctness` reviewer · eval harness running |
| M2 | Multiple reviewers · Matrix planner · Verify and Judge · risk tiers |
| M3 | GitHub Action · inline comments and verdicts · incremental re-review |
| M4 | Failback and circuit breakers · remote config · long-term review memory · `--ultra` |
