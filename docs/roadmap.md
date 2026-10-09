# Roadmap

What comes after M1–M4 ([architecture](architecture.md)), as of 2026-10-09 (0.7.0 released). The long-term direction, decided on 2026-10-01: ocra is not another review bot but the engine other review agents are built on.

## The rule while evaluation is scarce

Model runs cost money, and there is little. So: **ship what tests prove without a model first: contracts, reach, trust, cost control and operability. Prompts, rules and reviewers change only with an eval run behind them.** Labels come from real reviews. Every page states what was tested live; readiness is claimed only where it is shown.

## Where ocra stands

**What peers have that ocra lacks**, largest first:

1. **Platforms.** PR-Agent and Kodus support five or more (GitHub, GitLab, Bitbucket, Azure DevOps, Gitea); ocra supports GitHub and GitLab.
2. **Published quality numbers at scale.** Alibaba reports SEM-F1 25.1% on AACR-Bench (recall 12–20%); Kodus published how it raised recall from 53% to 62%. ocra publishes one run on 16 golden cases, too few to decide changes.
3. **Beyond one-shot review.** Chat commands in the pull request, learning from corrections, code graphs, IDE plugins.
4. **Production mileage.** Cloudflare runs 130k reviews a month at $1.19 each; ocra reviews its own pull requests and one other repository's, and has no external user.

**What ocra has that none of them publish:** defense in depth for untrusted pull requests (read-only agents, configuration and memory from the base commit, neutralized output, commands only from verified comments of people with write access, a threat model and a measured adversarial tier; see the manual's security page), structured output (a versioned JSON report, SARIF), a spend limit that says what it left, and a pipeline in which code decides everything but the judgment calls.

**What the first runs on Vertex showed:**

- **Recall is lost at the reviewers:** 14 findings across 20 baseline reviews, none refuted by Verify or dropped by the judge.
- **Ten AACR-Bench PRs cannot decide a change.** Two identical runs gave precision 66.7% and 40.0%: with 5–6 findings a run, one finding moves precision by 20 points.
- **AACR-Bench's line rule hides real hits:** by hand 64–86% of ocra's findings were real, against the 21–43% the benchmark scored.
- **A spend cap covers only a slice of a large pull request.** On a 14-file pull request (28 tasks) the $2 limit held ($1.69), but most files went unreviewed.
- **The deterministic stages' recall ceiling is 58.3%** on AACR-Bench; 40% of its issues are maintainability, which ocra does not report by design. Whether more context (callers, a code graph) raises recall is unmeasured: #144 merged without an eval.

## Direction: an engine-shaped product

**The decision (2026-10-01).** ocra is the infrastructure review agents are built on: stable contracts for the parts that vary (where the change comes from, how a task runs, who reviews what, where findings go) and one shared data model. The CLI, the Action and other tools are its hosts.

**Infrastructure means specifications with conformance suites, not a plugin registry** (compare Kubernetes' fixed core objects and certified CRI, CNI and CSI):

| Fixed, never pluggable | Pluggable, each with a conformance suite |
|---|---|
| The `Finding` model | `VcsAdapter` (3 implementations) |
| The stage order and its guarantees: budget, cancellation, coverage, exit codes | `AgentRuntime` (2) |
| The access policy every agent read goes through | `Reviewer` (5; the entity gets a scope and a tool set) |
| The trust rules of the review conversation (`vcs-platform`) | Analyzers: non-model finding sources (SARIF in) |
| | Sinks: where a report goes (the platform and SARIF today) |
| | Context providers, behind the one access policy |
| | Finding processors at fixed insertion points (after Execute, after Verify) |

Stages are inserted into, not replaced: whoever swaps Verify or Judge loses the quality and budget guarantees and blames ocra.

**The order rule.** Successful infrastructure carried load before it was designed (Kubernetes came out of Borg). So the reference reviewer (today's pipeline) stays the product and the engine's first customer, and must win on precision first; a contract is extracted when it or a second real implementation needs it, never ahead. This is `AGENTS.md`'s abstraction rule at project scale.

**Design decisions taken with the direction**, each to become an ADR when implemented:

1. **`Finding` stays the one model**, with provenance (source, model, run, cost) and a lifecycle (new, unfixed, fixed, dismissed). The verdict stays code; confidence is Verify's three-valued `verification`, never a model's self-reported number; anchoring stays quote-based; no free-form `metadata` bag. External analyzers enter as SARIF.
2. **The engine stays a synchronous orchestrator** that emits events; event-driven architecture belongs to a service layer, where each job is one engine call.
3. **Runtime and Strategy are two layers.** `runTask(spec) -> events` covers agent harnesses and model providers alike. A Strategy (how a change becomes tasks; today the bundle × reviewer matrix) is abstracted only when a second one is built. Harnesses that can write and run shells (Claude Code, Codex, Aider) become runtimes only if the conformance suite proves no write, no shell and no outbound network.
4. **Memory is decisions; knowledge is retrieval.** Memory holds what was accepted or dismissed, why and by whom, read from a trusted revision so a change cannot silence its own findings, in three scopes: organization, repository (`.ocra/memory.json`), path (rules).
5. **Context is one engine with providers** (`ReviewContext`): symbols, callers, ownership and documents join behind the same access policy.
6. **MCP** stays outside the trust boundary (ADR-0005); it may carry user-supplied context under the plugin trust rules, and ocra may serve "review this change" over it.
7. **Duplicate findings** are handled in four layers: scope partitioning in the matrix, deterministic merging (same file, overlapping anchor, same category), the judge's deduplication, and one publisher. A per-change cap truncates by severity and verification.

## Milestones

The roadmap sets no deadlines; each phase starts when the one before has shown what it set out to show.

### Done

- **M1–M4**: the pipeline, reviewers, GitHub, re-review, failover, memory ([architecture](architecture.md)).
- **M7 — Ship v0.1** (2026-09-29): npm with provenance, dogfood on two repositories, the quality page.
- **M8 — Untrusted pull requests** (2026-09-29): the adversarial tier (ADR-0014), the threat model and the gated `pull_request_target` recipe (ADR-0013). Carried over: a live check on a real fork pull request, and talking to three maintainers who receive outside contributions.
- **M9 — Reach and trust** (0.2.0, 2026-09-30): trust documents, release hardening, spend-limit reporting (ADR-0015), SARIF out, GitLab (ADR-0016), the container image, declared providers (ADR-0017), a security audit with every finding fixed or documented.

### Now: users and recall (from 2026-10-05, six weeks)

Decided on 2026-10-05: for six weeks the project is judged on two numbers, **external users** and **recall**. Everything else waits.

- **Users (M13):** offer setup pull requests to 20 open-source repositories with outside contributors and no AI reviewer, and watch each through its first ten reviews. Target: three external repositories running ocra for two weeks or more. First settle who pays for their model calls: the free model's shared daily pool cannot carry three busy repositories.
- **Recall (M11):** measure the golden score's run-to-run noise (one configuration three times), find from saved runs where expected issues are lost (never raised, or dropped by Verify, Judge or a severity filter), grow the golden set from AACR-Bench's in-scope issues; then one change at a time, measured against that noise. The tools for each landed in `ocra-eval` (`trend`, the recall funnel, `compare` that says what it can detect, `golden-import`); the first imported cases wait for review (#490).
- **Paused:** the rest of M10 and M12. **ocra Cloud (M14) is frozen**: running, security fixes only, no new features, no paid plan.
- **Week-six checkpoint:** with users and better recall, decide what Cloud becomes (candidate: a hosted GitHub App for fork pull requests); with no takers, find out why before building more.

The milestones below keep their lists; the order of work is the one above.

**M5 — Measure** and **M6 — Recall** (paused until credit, then folded into M11). M5: a quality number stable enough to decide changes; resumes with a golden smoke run of `main`, then the `[needs-eval]` backlog (about $60). M6: reviewers report every defect they can support while Verify and the judge own precision, one measured prompt change at a time, then callers as context (about $80).

**M10 — Contracts** (no credit). Landed: the Finding specification and JSON Schema (ADR-0018), SARIF in (ADR-0019), the public `review()` entry with curated, API-reported exports, and the second runtime with its conformance suite (ADR-0020). Paused: the reviewer entity (ADR-0021, proposed) and sinks (SARIF and the platform behind one contract). Carried over from 0.2.0: #290 (the separate GitLab reviewer project).

**M11 — Evidence** (a standing credit line; the free OpenRouter model covers what it can).

1. A nightly live smoke test. Running: `nightly-live.yml` on the free OpenRouter model with the `direct` runtime (gated by `OCRA_LIVE_SMOKE` and `OPENROUTER_API_KEY`), and `eval-free.yml` running the golden tiers on the rest of the free daily quota, in lanes of a model and a branch.
2. The golden set grown until a five-point change is visible; precision and recall per reviewer, model and language, with cost per change, as a trend across releases.
3. M5 and M6 under that evidence.
4. Only then: prompts, rules and reviewers unfreeze, one measured change at a time.

**M12 — Operability** (paused 2026-10-05).

1. **Organization policy** the reviewed repository cannot override (allowed models, spend limits, mandatory reviewers, excluded paths). Proposed in ADR-0022 (`OCRA_POLICY`, caps over every layer, fails closed).
2. **A run id** everywhere, and a published event schema. The run id landed (`runId` in the report, progress output, summary comment and SARIF log); the event schema is still internal.
3. **Metrics** from session files. Landed as `ocra metrics`.

**M13 — Use** (the focus). Three external teams on the Action or the GitLab job, their dismissals and replies feeding the golden set; the M8 maintainer conversations. If no team will run it, the next phase starts with the product layer, not the control plane. Landed in 0.7.0: `ocra init`.

**M14 — ocra Cloud** ([ADR-0024](adr/0024-ocra-cloud.md); frozen). Open core plus an optional hosted service on the published packages, in a private repository.

1. **Phase 1:** built, live at https://app.ocracloud.com (0.4.0, 0.5.0; hardened in 0.6.0, with the wire contract published as `@open-cr-agent/cloud-contract`): `ocra login`, the user's key behind a model gateway, metadata-only upload, account configuration ([ADR-0027](adr/0027-account-configuration.md)), opt-in findings and account memory ([ADR-0028](adr/0028-findings-upload-and-cloud-memory.md)), a web view. Left: external users (M13).
2. **Models and effort per agent** ([ADR-0025](adr/0025-per-agent-models-and-effort.md)): landed on both runtimes, with a per-agent cost estimate in `--plan` and the web's Agents page. Next: a policy cap on effort.
3. **Phase 2:** a hosted GitHub App with organizations ([ADR-0026](adr/0026-hosted-review-compute.md), proposed; deferred).
4. **Phase 3:** models ocra provides, a free allowance and paid plans, once there is a model budget.

**Review experience** (from a comparison with CodeRabbit; anything touching quality waits for M11).

1. A public run of the Martian Code Review Bench on free models, precision first (part of M11).
2. Committable suggestions. The plumbing landed ([ADR-0029](adr/0029-committable-suggestions.md)); producing the fix waits for an evaluated prompt change.
3. Pull request commands: a maintainer's reply asking for a re-review or dismissing a finding is acted on, within `vcs-platform`'s trust rules.
4. Semgrep as the first bundled analyzer behind SARIF in, off unless configured.
5. A pull request summary from the judged findings and the change, not a second free-text pass.

### Next: driven by the numbers of the phase before

- **M15 — Organization memory and context providers.** Organization-scoped memory with owners and expiry; `callers` and `ownership` as the first providers, each measured for recall; a code graph only if they move the number.
- **M16 — Reach on demand.** Bitbucket or Azure DevOps, whichever is asked for first, through the conformance suite; ocra as an MCP server; OpenTelemetry export.
- **Governance.** A second maintainer, an issue-response commitment and a version-support policy.

### Later: an ecosystem

- **M17 — Certified extensions.** Third-party reviewers, analyzers, runtimes and adapters certified against the conformance suites.
- The Finding specification and the Reviewer and Runtime contracts published as standalone documents, open to outside implementations.

## Readiness checklist

What a company checks before adopting a code review tool, and where ocra is.

| Area | Status |
|---|---|
| Install | npm with provenance; the Action; a container image with attested provenance |
| Platforms | GitHub; GitLab (GitLab.com and self-managed), tested against a fake API and checked live on GitLab.com Free |
| Embedding | The CLI, and the `review()` entry (a contract under the 0.x rule); a curated public API in every package, recorded in API reports checked in CI |
| Data stays with the customer | Runs in the customer's CI with their keys and no ocra service in between; own endpoints, proxies and CA bundles |
| Model providers | OpenCode's catalog (all but 7 of 225) and declared endpoints; tested live: Gemini on Vertex, the Gemini API, a free OpenRouter model |
| Security | Threat model, adversarial tier, `SECURITY.md` with private reporting, one conformance suite for every platform's trust rules, an M9 security audit (2026-09-30). For a same-project GitLab merge request the review is advice its author could forge (#290) |
| Supply chain | Trusted publishing, SLSA provenance required by the Action, tarball digests from pack to publish, an attested image; no code fetched at review time, only OpenCode's pricing catalog (none with the `direct` runtime) |
| Cost control | Spend limit that says what it left, task cap, token and dollar reporting |
| Policy | Repository and remote configuration; no organization policy the repository cannot override (M12) |
| Integrations | Versioned JSON report with a JSON Schema; SARIF 2.1.0 out and in (`--import-sarif`); no sinks contract (M10) |
| Observability | Session files with cost, tokens and latency; one run id across session, report, progress output, summary comment and SARIF; `ocra metrics`; no published event schema (M12) |
| Quality evidence | 16 golden cases: one run on Gemini, two smoke-tier runs on a free model (not comparable); nightly live smoke and daily free golden evaluation (M11) |
| Support and stability | Early 0.x; the Stability and support page names the contracts; one maintainer |
| Production use | Dogfood on two repositories; no external user yet (M13) |

## Not now

- **Replaceable pipeline stages.** Insertion points only (see Direction).
- **A code graph, AST or call-graph context** before one provider is shown to raise recall.
- **An embedding store for memory** before fingerprint matching is shown to be the limit.
- **MCP inside the trust boundary** (ADR-0005).
- **Demo features**: chat commands, auto-fix, IDE plugins, issue-tracker checks, full-repository scans. None helps until review quality is proven; memory, dismissals and replies cover the "learning" peers advertise.
- **Five platforms or seven runtimes at once.** One maintainer cannot keep them alive; each is added on demand through a conformance suite.
- Any prompt, rule or reviewer change until M11.

## Risks of the direction

1. **The architecture outruns the use.** Contracts versioned for nobody break for everybody; the order rule is the guard, and M13 the test.
2. **Quality comes from the model and the context, not the framework.** A reference reviewer that loses to GitHub Copilot Review or Cursor Bugbot, bundled and nearly free, gets no users. M11 is the guard.
3. **Abstractions over fast-moving vendors leak every quarter**, and one maintainer's bandwidth goes to keeping up. Conformance suites and on-demand reach are the guard.

## Positioning, to be tested

1. **The reviewer you can run on strangers' pull requests.** Supported by M8; tested by talking to open-source maintainers.
2. **The engine review agents are built on**: stable contracts, a shared finding model, a conformance suite for every pluggable part. Tested by whether anyone builds on the contracts.
3. **What large tools do not cover: GitLab and self-hosted deployments, then Gitee and domestic models.** M9 built the reach; dogfood cannot show demand.
