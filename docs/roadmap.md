# Roadmap

What comes after M1–M4 (`docs/architecture.md`, all built) and the 0.2.0 release, as of 2026-10-01. It records the maintainer's long-term direction, decided on 2026-10-01: ocra is not another review bot but the engine other review agents are built on. It also keeps what the earlier roadmap answered: a comparison with open-source peers, what ocra's first model runs showed, and the goal of 2026-09-30, a project a company can adopt and a company could be built on.

## The rule while evaluation is scarce

Evaluation runs on models cost money, and today there is little of it. So: **ship what tests prove without a model first: contracts, reach, trust, cost control and operability. Prompts, rules and reviewers change only with an eval run behind them.** Labels keep coming from real reviews. Every page states what was tested live and what was not; readiness is claimed only where it is shown. M5 and M6 resume when evaluation is funded; free models (M11) cover what they can.

## Where ocra stands

**What peers have that ocra lacks**, largest gap first:

1. **Platforms.** PR-Agent and Kodus support five or more (GitHub, GitLab, Bitbucket, Azure DevOps, Gitea); ocra supports GitHub and GitLab.
2. **Published quality numbers at scale.** Alibaba reports SEM-F1 25.1% on AACR-Bench (recall 12–20%); Kodus published how it raised recall from 53% to 62%. ocra publishes one run on 16 golden cases (the quality page), too few to decide changes.
3. **Beyond one-shot review.** Chat commands in the pull request (`/ask`, `/describe`), learning from corrections, code graphs, IDE plugins.
4. **Production mileage.** Cloudflare runs 130k reviews a month at $1.19 each; ocra reviews its own pull requests and one other repository's, and has no external user.

**What ocra has that none of them publish:** defense in depth for untrusted pull requests. No write, shell or web tools for agents; an environment allowlist; configuration, rules and memory from the base commit; prompt-injection boundaries; neutralized comment output, with no commands and no links from model text; commands only from verified, unedited comments of people with write access; a threat model and a measured adversarial tier. Also: structured output (a versioned JSON report, SARIF), a per-run spend limit that says what it left, and a pipeline in which code decides everything but the judgment calls.

**What the first runs on Vertex showed:**

- **Recall is the gap, and it is lost at the reviewers.** Across 20 baseline reviews the reviewers reported 14 findings in total; Verify refuted none and the judge dropped none.
- **Ten AACR-Bench PRs cannot decide a change.** Two identical runs gave precision 66.7% and 40.0%: with 5–6 findings a run, one finding moves precision by 20 points.
- **AACR-Bench's line rule hides real hits**, and by hand 64–86% of ocra's findings there were real, against the 21–43% the benchmark scored.
- **A spend cap covers only a slice of a large pull request.** On a jmos pull request (14 files, 28 tasks) the $2 limit held ($1.69), but most files went unreviewed, because tasks ran bundle by bundle.
- **The recall ceiling of the deterministic stages is 58.3%** on AACR-Bench, and 40% of the benchmark's issues are maintainability, which ocra does not report by design. Whether more context (callers, a code graph) raises recall has not been measured: #144 merged without an eval.

## Direction: an engine-shaped product

**The decision (2026-10-01).** ocra's long-term position is the infrastructure review agents are built on, not one of the agents: a review engine with stable contracts for the parts that vary (where the change comes from, how a task runs, who reviews what, where findings go), and one shared data model for what they exchange. The products on top of it (the CLI, the Action, the image, a service one day, other people's tools) are its hosts.

**What "infrastructure" means here.** Specifications with conformance suites, not a plugin registry. The analogy is OpenTelemetry, whose product is the specification and the semantic conventions, and Kubernetes, whose core objects are fixed while CRI, CNI and CSI are pluggable and certified. For ocra:

| Fixed, never pluggable | Pluggable, each with a conformance suite |
|---|---|
| The `Finding` model (the shared language; it is the Pod) | `VcsAdapter` (3 implementations today) |
| The pipeline's stage order and its guarantees: budget, cancellation, coverage, exit codes | `AgentRuntime` (1 today; the second is justified below) |
| The access policy every agent read goes through | `Reviewer` (5 today; the entity gets a scope and a tool set) |
| The trust rules of the review conversation (`vcs-platform`) | Analyzers: finding sources that are not a model (none today; SARIF in) |
| | Sinks: where a report goes (the platform and SARIF today) |
| | Context providers, all behind the one access policy |
| | Finding processors at fixed insertion points (after Execute, after Verify) |

Stages are inserted into, not replaced: whoever swaps Verify or Judge gets a pipeline with no quality or budget guarantee and blames ocra for it. Insertion points are the admission-webhook pattern; replacement is not offered.

**The order rule.** No successful open-source infrastructure was designed before it carried load: Kubernetes came out of Borg, OpenTelemetry out of two projects with users, Backstage out of four years inside Spotify. So the reference reviewer (today's pipeline) stays the product, is the engine's first customer, and has to win on precision first; every contract is extracted when the reference reviewer or a second real implementation needs it, never ahead of that. The abstraction rule in `AGENTS.md` (introduce one at the second real use case) is the same rule at file scale.

**Design decisions taken with the direction**, to become ADRs as each is implemented:

1. **`Finding` stays the one model**, extended with provenance (source, model, run, cost) and a full lifecycle (new, unfixed, fixed, dismissed). Severity keeps blocking semantics (`critical`, `warning`, `suggestion`) and the verdict stays code. Confidence is the three-valued `verification` produced by an independent step, never a number a model reports about itself. Locations keep quote-based anchoring with the method recorded, since models cannot give line numbers. No free-form `metadata` bag. External analyzers enter as SARIF and are mapped once; ocra does not define a universal static-analysis schema.
2. **The engine stays a synchronous orchestrator** that emits events (today's `ReviewEvent` and the session JSONL). Event-driven architecture belongs to the service layer (webhook, queue, worker), where each job is one engine call.
3. **Runtime and Strategy are two layers.** `runTask(spec) -> events` already unifies agent harnesses (they own the tool loop) and model providers (ocra owns the loop). Above it, a Strategy decides how a change becomes tasks and how results merge: today the bundle × reviewer matrix; a whole-change multi-round agent or an analyzers-first run would be others. A Strategy abstraction is introduced only when a second strategy is built. Harnesses that can write files and run shells (Claude Code, Codex, Gemini CLI, Aider) become runtimes only if the runtime conformance suite proves they ran with no write, no shell and no outbound network.
4. **Memory is decisions; knowledge is retrieval.** Memory holds what was accepted or dismissed, why and by whom, structured and small, read from a trusted revision so a change cannot silence its own findings. Documents (ADRs, wikis, past reviews) are a context provider's job. Memory has three scopes, by trust boundary: organization (administrators only, versioned, with owners and expiry), repository (today's `.ocra/memory.json`), path (rules). No embedding store until fingerprint matching is shown to be the limit.
5. **Context is one engine with providers**, which is what `ReviewContext` already is with three methods. Providers (symbols, callers, ownership, documents) join behind the same policy. A code graph is built only after one provider (callers) is shown to raise recall.
6. **MCP** is not used inside the trust boundary (ADR-0005 stands: typed tools, policy enforced in core). It may carry user-supplied context (issue trackers, wikis) when loaded under the same trust rules as plugins, and ocra itself exposes "review this change" as an MCP server, a distribution channel that costs little.
7. **Duplicate findings across agents** are handled in four layers, in this order: scope partitioning in the matrix, deterministic merging (same file, overlapping anchor, same category; the merged finding cites every source), the judge's semantic deduplication, and a single publisher that owns the conversation. A cap on findings per change truncates by severity and verification rather than posting everything.

## Milestones

### Done

- **M1–M4** (`docs/architecture.md`): the pipeline, reviewers, GitHub, re-review, failover, memory.
- **M7 — Ship v0.1** (2026-09-29): on npm with provenance; dogfood on two repositories; the measured-quality page.
- **M8 — Own the untrusted-PR niche** (2026-09-29): the adversarial golden tier (ADR-0014), the threat model and the gated `pull_request_target` recipe (ADR-0013), and the hardening they led to. Carried over, none of it paid from credit: a live check of the fork recipe on a real fork pull request (a second account; the maintainer's call), and talking to three maintainers who receive outside contributions.
- **M9 — Reach and trust** (0.2.0, 2026-09-30): trust documents (#269), release hardening (#270), what a spend limit leaves (ADR-0015, #271), SARIF (#272), GitLab (ADR-0016, #273–#275), the container image (#276), declared model providers (ADR-0017, #279), and a security audit with every finding fixed or documented (#281–#287).

### Paused until credit returns

- **M5 — Measure.** A quality number stable enough to decide changes and honest enough to publish. The golden set has 16 cases (10 smoke) and 26 expected findings; evaluation fixes are done (#250, #251). Resumes with one golden smoke run of `main`, then the `[needs-eval]` backlog with the cheapest check that answers each. About $60.
- **M6 — Recall.** Move recall without giving back precision: split the gate (reviewers report every defect they can support; Verify and the judge own precision), one prompt change at a time, each measured; then context (#144's callers). About $80.

When the direction's standing credit line exists, M5 and M6 fold into M11 below.

### Now: prove the reference reviewer, extract the engine

The roadmap sets no deadlines: each phase starts when the one before it has shown what it set out to show, and ships piece by piece as each item lands. Getting ocra in front of users comes first: M13 starts now, alongside M10–M12, and nothing waits for the contracts to be complete.

This phase's success condition is not a list of interfaces: it is three external teams running ocra on their real pull requests, and a per-reviewer precision number published from a golden set large enough to see a five-point change. Everything else serves those two.

**M10 — Contracts** (no credit). The engine becomes something a program, not only a shell, can call, and its shared model becomes a specification.

1. **Finding specification v1**: provenance, lifecycle and anchoring fixed; a published JSON Schema; the JSON report versioned against it. Landed as ADR-0018 (provenance per finding, usage per task, the schema generated and tested); the session log stays internal, as the stability page says.
2. **SARIF in**: external findings mapped into `Finding` once, with Semgrep as the first analyzer and the first use of the Analyzer contract. Landed as ADR-0019 (`--import-sarif`; ocra runs no tool; the log is the Analyzer contract until a second source appears).
3. **A public `review()` entry** in `core` with a curated export surface, a contract page in the manual and a deprecation policy; the CLI becomes its first caller. `core`'s `export *` surface is replaced by the curated one. Landed: `review()` and the Embedding page (the contract and its 0.x rule on the stability page), and the curated export surface: named main entries for every published package, `./internal` entries for what the packages share, and API reports in `etc/` checked in CI.
4. **A second `AgentRuntime`**, a direct SDK tool loop that does not go through OpenCode, and with it the runtime conformance suite: no write, no shell, no outbound network but the model endpoint. It also removes OpenCode's catalog fetch and npm plugin install from review time. Landed as ADR-0020 (`runtime-direct`, declared endpoints only; the shared loop logic in core; the suite runs against both runtimes).
5. **Reviewer as an entity**: scope, tool set and output schema declared, not only a prompt and a tier; finding processors at the two insertion points. Design proposed in ADR-0021: the per-reviewer tool set can land now; processors land with their first customer (M12 policy, the adversarial canary check); one output schema until a second shape exists.
6. **Sinks**: SARIF and the platform behind one contract, so a report can go to more than one place in a run.
7. Carried over from 0.2.0: #289 (the GitHub setup people with push access cannot change, end to end), #290 (the separate GitLab reviewer project); the live GitLab check ran on GitLab.com Free on 2026-10-04. #288 landed in #302.

**M11 — Evidence** (a standing credit line: cents a run for the nightly test, tens of dollars for golden runs; the free OpenRouter model covers what it can).

1. A nightly live smoke test in CI on a two-file pull request with the cheapest model, gated by a secret: the first real-model integration test the project has. The workflow exists (`nightly-live.yml`: a fixed seven-file change of this repository on the free OpenRouter model with the `direct` runtime, every task completed, $0, gated by the `OCRA_LIVE_SMOKE` variable and the `OPENROUTER_API_KEY` secret); it runs once the maintainer sets both.
2. The golden set grown until a five-point change is visible; precision and recall published per reviewer, per model and per language, with cost per change, as a trend across releases.
3. M5 and M6 as written above, under that evidence.
4. Only then: prompts, rules and reviewers unfreeze, one change at a time, each measured.

**M12 — Operability** (no credit).

1. **Organization policy**: a central configuration the reviewed repository cannot override (allowed models, spend limits, mandatory reviewers, excluded paths), with a documented precedence over remote and repository configuration. Design proposed in ADR-0022 (`OCRA_POLICY`, caps over every layer, fails closed, reported).
2. **A run id** through logs, comments, the report and the session file; the event schema versioned and published. The run id landed (the session id, in the report as `runId`, in the progress output, the summary comment and the SARIF log); the event schema is still internal.
3. Minimal metrics an operations team can scrape from session files: runs, cost, findings, dismissals, acceptance rate, per reviewer. Landed as `ocra metrics` (text and versioned JSON over the sessions' `report.json`).

**M13 — Use** (people, not code; starts now). Three external teams on the Action or the GitLab job, reviewing their real pull requests, with their dismissals and replies feeding the golden set; the three-maintainer conversations from M8. If no team will run it, the next phase starts with the product layer, not the control plane.

### Next: the control plane, driven by the numbers of the phase before

- **M14 — Control plane.** A service that receives webhooks, queues jobs, holds keys and budgets per organization and writes an audit log; each job is one call of the `review()` entry. Event-driven here, not inside the engine.
- **M15 — Organization memory and context providers.** Organization-scoped memory with owners and expiry; `callers` and `ownership` as the first providers, each measured for recall before the next; a code graph only if they move the number.
- **M16 — Reach on demand.** Bitbucket or Azure DevOps, whichever is asked for first, through the conformance suite; ocra as an MCP server for agent IDEs; OpenTelemetry export once there are sessions to aggregate.
- **Governance.** A second maintainer, an issue-response commitment and a version-support policy, since a buyer asks who is accountable before asking what the contracts are.

### Later: an ecosystem

- **M17 — Certified extensions.** Third-party reviewers, analyzers, runtimes and adapters registered and certified against the conformance suites, the way CSI drivers are.
- The Finding specification and the Reviewer and Runtime contracts published as documents of their own, open to implementations outside this repository.
- A hosted offering, if the business case holds, built on the same engine entry and not a fork of it.

## Readiness checklist

What a company checks before adopting a code review tool, and where ocra is. Updated as milestones land.

| Area | Status |
|---|---|
| Install | npm with provenance; the Action; a container image with attested provenance |
| Platforms | GitHub; GitLab (GitLab.com and self-managed), tested against a fake API and checked live on GitLab.com Free |
| Embedding | The CLI, and the `review()` entry with its Embedding page (a contract under the 0.x rule); a curated public API in every package, recorded in API reports checked in CI |
| Data stays with the customer | Runs in the customer's CI with the customer's model keys; no ocra service in between; your own OpenAI-compatible endpoint; corporate proxies and CA bundles pass through |
| Model providers | Any provider in OpenCode's catalog whose SDK OpenCode bundles (all but 7 of 225), and declared endpoints, through OpenCode or the `direct` runtime; tested live: Gemini on Vertex, the Gemini API, and a free model through OpenRouter |
| Security | Threat model with who controls the pipeline, adversarial tier, `SECURITY.md` with private reporting, one conformance suite for every platform's trust rules, a security audit of M9 with every finding fixed or documented (2026-09-30). For a same-project GitLab merge request the review is advice its author could forge (#290 tries a fix) |
| Supply chain | Trusted publishing, SLSA provenance required by the Action, the package check in its own job, tarball digests carried from pack to publish, an attested image; no code is fetched at review time (OpenCode's npm installs go to a refusing local registry), only the pricing catalog, and with the `direct` runtime not even that |
| Cost control | Per-run spend limit that stops running tasks and says what it left, task cap, token and dollar reporting, prices required for declared models |
| Policy | Repository and remote configuration; no organization-level policy the repository cannot override (M12) |
| Integrations | Versioned JSON report with a published JSON Schema; SARIF 2.1.0 out; SARIF in (`--import-sarif`); no sinks contract yet (M10) |
| Observability | Session files with cost, tokens and latency per run, and one run id across the session directory, the report, the progress output, the summary comment and the SARIF log; `ocra metrics` over the session reports; no published event schema (M12) |
| Quality evidence | 16 golden cases, one run, agent labels spot-checked by a second model; a nightly live smoke workflow on a free model, waiting for its secret; golden runs paused with the credit (M11) |
| Support and stability | Early 0.x; the Stability and support page names the contracts; one maintainer |
| Production use | Dogfood on two repositories; no external user yet (M13) |

## Not now

- **A hosted service or GitHub App before the control-plane phase.** It needs users and hosting money; the CLI, the Action and the image already let a company run ocra inside its own CI with its own keys, which is what self-hosting customers ask for. The `review()` entry is what the service is built on.
- **Replaceable pipeline stages.** Insertion points, not replacement (see Direction).
- **A code graph, AST or call-graph context** before one provider is shown to raise recall.
- **An embedding store for memory** before fingerprint matching is shown to be the limit.
- **MCP inside the trust boundary** (ADR-0005).
- **Demo features**: chat commands in the pull request, auto-fix, IDE plugins, issue-tracker checks, full-repository scans, agents that "optimize themselves". Each is a product of its own; none appears on an enterprise checklist, and none helps until review quality is proven. ocra already keeps `.ocra/memory.json`, human dismissals and replies, which cover the "learning" peers advertise at the scale ocra has.
- **Five platforms or seven runtimes at once.** One maintainer cannot keep them alive; each is added on demand through a conformance suite.
- Any prompt, rule or reviewer change until M11, and #171 (a model-specific failure not reproduced on Vertex).

## Risks of the direction

1. **The architecture outruns the use.** Contracts versioned for nobody break for everybody; the order rule above is the guard, and M13 is the test.
2. **Quality comes from the model and the context, not from the framework.** A reference reviewer that loses to GitHub Copilot Review or Cursor Bugbot, both bundled and nearly free, gets no users whatever its plugin system. M11 is the guard.
3. **Abstractions over fast-moving vendors leak every quarter** (the LangChain problem), and a single maintainer's bandwidth goes to keeping up. Conformance suites and on-demand reach are the guard.

## Positioning, to be tested

1. **The reviewer you can run on strangers' pull requests.** Supported by M8; tested by talking to open-source maintainers.
2. **The engine review agents are built on**: stable contracts, a shared finding model, and a conformance suite for every pluggable part. Decided on 2026-10-01; tested by whether anyone builds on the contracts.
3. **What large tools do not cover: GitLab and self-hosted deployments, then Gitee and domestic models.** M9 built the reach; dogfood alone cannot show demand.
