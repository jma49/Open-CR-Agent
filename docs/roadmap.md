# Roadmap

What comes after M1–M4 (`docs/architecture.md`, all built), as of 2026-09-30. It answers a comparison with open-source peers (Alibaba open-code-review, PR-Agent, Kodus, claude-code-action, Cloudflare's published design), what ocra's first model runs showed, and the maintainer's goal of 2026-09-30: a project a company can adopt, and a company could be built on.

## The rule while model credit is frozen

Model runs are paid from a Google Cloud trial credit, and the maintainer set a floor: nothing is spent below $100 left. What remains above it is the dogfood allotment in CI and $6.18 of evaluation money, which cannot buy a quality number: one golden smoke run costs about $11.

So, until new credit arrives: **ship only what tests prove without a model: reach, trust, cost control and operability. Prompts, rules and reviewers stay frozen, and no `[needs-eval]` change merges.** Labels keep coming from real reviews (dogfood), which cost nothing extra. Every page states what was tested live and what was not; readiness is claimed only where it is shown.

It replaces the earlier rule, "no feature work that a quality number cannot justify", which assumed the credit to buy numbers. Once credit is back, M5 and M6 resume, starting with one golden smoke run of `main` (about $11).

## Where ocra stands

**What peers have that ocra lacks**, largest gap first:

1. **Platforms.** PR-Agent and Kodus support five or more (GitHub, GitLab, Bitbucket, Azure DevOps, Gitea); ocra supports GitHub.
2. **Published quality numbers at scale.** Alibaba reports SEM-F1 25.1% on AACR-Bench (recall 12–20%); Kodus published how it raised recall from 53% to 62%. ocra publishes one run on 16 golden cases (the quality page), too few to decide changes.
3. **Beyond one-shot review.** Chat commands in the pull request (`/ask`, `/describe`), learning from corrections, code graphs, IDE plugins.
4. **Production mileage.** Cloudflare runs 130k reviews a month at $1.19 each; ocra reviews its own pull requests and one other repository's, and has no external user.

Installation is no longer a gap: v0.1.2 is on npm with provenance, and the Action installs the published CLI.

**What ocra has that none of them publish:** defense in depth for untrusted pull requests. No write, shell or web tools for agents; an environment allowlist; configuration, rules and memory from the base commit; prompt-injection boundaries; neutralized comment output, with no commands and no links from model text; commands only from verified, unedited comments of people with write access; a threat model and a measured adversarial tier.

**What the first runs on Vertex showed** (`docs/handoff.md`):

- **Recall is the gap, and it is lost at the reviewers.** Across 20 baseline reviews the reviewers reported 14 findings in total; Verify refuted none and the judge dropped none.
- **Ten AACR-Bench PRs cannot decide a change.** Two identical runs gave precision 66.7% and 40.0%: with 5–6 findings a run, one finding moves precision by 20 points.
- **AACR-Bench's line rule hides real hits**, and by hand 64–86% of ocra's findings there were real, against the 21–43% the benchmark scored.
- **A spend cap covers only a slice of a large pull request.** On a jmos pull request (14 files, 28 tasks) the $2 limit held ($1.69), but most files went unreviewed, because tasks ran bundle by bundle.

## Milestones

### M9 — Reach and trust (merged 2026-09-30; ships in 0.2.0)

Goal: a team on GitHub or GitLab, self-hosted or not, can adopt ocra, audit how it is built, and keep its cost bounded, without asking the maintainer. Each item is one or a few small pull requests, tested without a model. All seven are merged (the PR numbers follow each item); they reach users with the 0.2.0 release, which waits for two first publishes by hand (`docs/handoff.md`).

1. **Trust documents.** `SECURITY.md` with private reporting, `CONTRIBUTING.md`, a code of conduct, issue templates, and a manual page on what is a contract (flags, configuration, exit codes, the JSON report, the summary state) and how it may change. #269.
2. **Release hardening**, from `docs/releasing.md`: the Action requires ocra's own provenance or builds from source; `check:packages` in its own job; OpenCode's binary found without optional dependencies. #270.
3. **What a spend limit leaves** (ADR-0015, #271): the report names the files a limit left unreviewed and says the limit was reached, and a pull request's next review continues with them. Tasks keep finishing files in plan order, since the review state tracks unfinished work per file; breadth first would re-spend every push on the same first reviewers. No prompt changes.
4. **SARIF output**, for code scanning dashboards and security tools. #272.
5. **GitLab merge requests** (ADR-0016): the platform-neutral parts of publishing move out of `vcs-github`, a `vcs-gitlab` adapter, `--mr`, and a GitLab CI template. First release: merge requests from the same project; fork merge requests documented, not automated. #273, #274, #275.
6. **A container image** on GHCR, built from the published CLI with provenance, for GitLab CI, Jenkins and other runners. #276.
7. **Model providers**: a page for each provider in OpenCode's catalog with what was tested live (Gemini API and Vertex), and endpoints of your own that speak the OpenAI API, declared in configuration with a price per model (ADR-0017, #279).

Then Gitea and Gitee, if GitLab shows the adapter shape holds and someone asks.

### M7 — Ship v0.1 (published 2026-09-29; dogfooding)

- v0.1.2 is on npm with provenance (trusted publishing from GitHub releases; token publishing disallowed); the README and quickstart install with one line.
- Dogfood, live since 2026-09-29 for ocra and jmos (keyless Vertex, a ledger in CI): the Action on real pull requests for a month; every dismissal and confirmed finding there feeds the golden set.
- The measured-quality page is live.

### M8 — Own the untrusted-PR niche (merged 2026-09-29; a first probe ran)

- Built: the adversarial golden tier (#256, ADR-0014), the threat model and a gated `pull_request_target` recipe (#253, ADR-0013), and the hardening they led to (#252, #254, #264).
- Remaining, none of it paid from the frozen credit: a live check of the fork recipe on a real fork pull request (needs a second account and a trust setup that allows `pull_request_target`; the maintainer's call), and talking to three maintainers who receive outside contributions.
- Paused with the credit: repeated adversarial runs, and a pull request's own title and body as an attack channel.

### M5 — Measure (paused until credit returns)

Goal: a quality number stable enough to decide changes and honest enough to publish. The golden set has 16 cases (10 smoke) and 26 expected findings; evaluation fixes are done (#250, #251). Resumes with one golden smoke run of `main`, then the `[needs-eval]` backlog with the cheapest check that answers each. Budget when it resumes: about $60.

### M6 — Recall (paused until credit returns)

Goal: move recall without giving back precision. Split the gate (reviewers report every defect they can support; Verify and the judge own precision), one prompt change at a time, each measured; then context (#144's callers). Budget when it resumes: about $80.

## Readiness checklist

What a company checks before adopting a code review tool, and where ocra is. Updated as M9 lands.

| Area | Status |
|---|---|
| Install | npm with provenance; the Action; a container image from 0.2.0 |
| Platforms | GitHub; GitLab (GitLab.com and self-managed) from 0.2.0, tested against a fake API |
| Data stays with the customer | Runs in the customer's CI with the customer's model keys; no ocra service in between; your own OpenAI-compatible endpoint from 0.2.0 |
| Model providers | Any provider in OpenCode's catalog, and declared endpoints; tested live: Gemini on Vertex and the Gemini API |
| Security | Threat model, adversarial tier, `SECURITY.md` with private reporting, one conformance suite for every platform's trust rules |
| Supply chain | Trusted publishing, SLSA provenance required by the Action, the package check in its own job, an attested image; OpenCode still fetches its catalog and plugin package at start (spike 0002) |
| Cost control | Per-run spend limit that stops running tasks and says what it left, task cap, token and dollar reporting, prices required for declared models |
| Integrations | Versioned JSON report; SARIF 2.1.0 |
| Quality evidence | 16 golden cases, one run, agent labels spot-checked by a second model; paused with the credit |
| Support and stability | Early 0.x; the Stability and support page names the contracts |
| Production use | Dogfood on two repositories; no external user yet |

## Not now

- **A hosted service or GitHub App.** It needs users and hosting money; the CLI, the Action and the image already let a company run ocra inside its own CI with its own keys, which is what self-hosting customers ask for.
- **`ocra stats` or OpenTelemetry export.** Session files already record cost, tokens and latency per run; aggregation waits for someone with sessions to aggregate.
- Chat commands in the pull request, IDE plugins, issue-tracker checks, full-repository scans and a code graph beyond #144. Each is a product of its own; none helps until review quality is proven. ocra already keeps `.ocra/memory.json`, human dismissals and replies, which cover the "learning" peers advertise at the scale ocra has.
- Any prompt, rule or reviewer change, and #171 (a model-specific failure not reproduced on Vertex).

## Positioning, to be tested

1. **The reviewer you can run on strangers' pull requests.** Supported by M8; tested by talking to open-source maintainers.
2. **What large tools do not cover: GitLab and self-hosted deployments, then Gitee and domestic models.** Now under test: M9 builds the reach, and dogfood alone cannot show demand.
