# Roadmap

What comes after M1–M4 (`docs/architecture.md`, all built), as of 2026-09-29. It answers a comparison with open-source peers (Alibaba open-code-review, PR-Agent, Kodus, claude-code-action, Cloudflare's published design) and what ocra's first model runs showed. The order follows one rule: **no feature work that a quality number cannot justify, until ocra has a quality number worth publishing.**

## Where ocra stands

**What peers have that ocra lacks**, largest gap first:

1. **Published quality numbers.** Alibaba reports SEM-F1 25.1% on AACR-Bench (recall 12–20%); Kodus published how it raised recall from 53% to 62%. ocra has an evaluation harness and, since 2026-09-28, a baseline, but nothing publishable.
2. **Installation.** Everyone else installs with one command (npm, PyPI, Docker, a marketplace Action). ocra is built from source.
3. **Platforms.** PR-Agent and Kodus support five or more (GitHub, GitLab, Bitbucket, Azure DevOps, Gitea); ocra supports GitHub.
4. **Beyond one-shot review.** Chat commands in the pull request (`/ask`, `/describe`), learning from corrections, code graphs, IDE plugins.
5. **Production mileage.** Cloudflare runs 130k reviews a month at $1.19 each; ocra has no external user.

**What ocra has that none of them publish:** defense in depth for untrusted pull requests. No write, shell or web tools for agents; an environment allowlist; configuration, rules and memory from the base commit; prompt-injection boundaries; neutralized comment output; commands only from verified, unedited comments of people with write access.

**What the first runs on Vertex showed** (`docs/handoff.md`):

- **Recall is the gap, and it is lost at the reviewers.** Across 20 baseline reviews the reviewers reported 14 findings in total; Verify refuted none and the judge dropped none. Kodus's lesson (Verify discarding too much) does not apply yet: ocra's reviewers barely report. Their prompts end "If a finding would not survive a skeptical senior engineer, do not report it."
- **Ten AACR-Bench PRs cannot decide a change.** Two identical runs gave precision 66.7% and 40.0%: with 5–6 findings a run, one finding moves precision by 20 points.
- **AACR-Bench's line rule hides real hits.** On electron@6084595 ocra reported the annotated critical use-after-free, anchored ten lines from the reference; matching allows one line, so it counted as a miss and a false positive.
- **Security findings on trivial or sensitive-path PRs did not appear** when #85 and #103 ran the security reviewer there: the benchmark's security references on those PRs are hardening suggestions, which the reviewer is not asked for.

## Milestones

### M5 — Measure (now)

Goal: a quality number that is stable enough to decide changes and honest enough to publish.

- Golden set (ADR-0011): review and merge the seed (#186); run the smoke tier twice for its spread; grow it to 10 smoke and 25 full cases, including other languages from adjudicated AACR-Bench findings.
- Evaluation fixes, done: a lenient diagnostic match (same file, same concern, any line) reported next to the official one, so anchoring distance and model quality are told apart; the ceiling heading names the dataset (#250); a golden label applies only to the claim it was recorded for (#251, ADR-0012).
- Decide the `[needs-eval]` backlog with the cheapest check that answers each: targeted runs on the PRs a change affects (#85, #103 done), the golden smoke tier, or 30+ PRs for prompt changes (#126 first, then #142–#146, #150).
- Budget: about $60 of the Vertex credit.

### M6 — Recall (next)

Goal: move recall without giving back precision, measured on the golden set and 30+ AACR-Bench PRs.

- Split the gate: reviewers report every defect they can support with evidence; Verify and the judge, which already exist and drop nothing today, own precision. One prompt change at a time, each measured.
- Then context: #144's callers of changed symbols, and whether reviewers use their step budget (some stop after 8 steps).
- Budget: about $80.

### M7 — Ship v0.1 (published 2026-09-29; dogfooding next)

Goal: someone other than the maintainer can install and use ocra in five minutes.

- Done on 2026-09-29.
  - `@open-cr-agent/cli` and its four library packages are on npm at 0.1.0. The first publish was by hand; later releases publish from GitHub releases through trusted publishing, and token publishing is disallowed.
  - The GitHub release is v0.1.0.
  - The README and quickstart install with one line (#234).
- Dogfood, live since 2026-09-29 for ocra and jmos (keyless Vertex, a $60 budget with a ledger in CI): the Action on real pull requests for a month; every dismissal and confirmed finding there feeds the golden set.
- Publish the evaluation: done in the manual (#232, the quality page), and live once the site is deployed.

### M8 — Own the untrusted-PR niche (built 2026-09-29, waiting for merge and a first run)

Goal: turn the security design into something a maintainer of a popular open-source repository can verify.

- An adversarial golden tier: pull requests whose title, description, comments or code try to suppress findings, forge commands or plant links; the claim "injection does not change the verdict" becomes a measured number. Built: #256 (ADR-0014), six attacks on four smoke cases, through the description and the code. A pull request's own title and replies are not attack channels in it yet. The first run needs budget.
- A threat-model page in the manual; guidance for `pull_request_target` and fork pull requests. Written: #253 (ADR-0013), a gated `pull_request_target` workflow. The analysis behind it hardened two places (#252, #254). A live fork check is pending.
- Talk to three maintainers who receive outside contributions before building more.

### M9 — Reach (after M7 shows demand)

- GitLab as the second `VcsAdapter` (the largest platform gap), then Gitea/Gitee if the second positioning hypothesis (self-hosted and Chinese platforms, domestic models) finds users.
- A Docker image alongside npm.

## Not now

Chat commands in the pull request, IDE plugins, issue-tracker checks, full-repository scans and a code graph beyond #144. Each is a product of its own; none helps until review quality is proven. ocra already keeps `.ocra/memory.json`, human dismissals and (#145) replies, which cover the "learning" peers advertise at the scale ocra has.

## Positioning, to be tested

1. **The reviewer you can run on strangers' pull requests.** Supported by M8; tested by talking to open-source maintainers.
2. **What large tools do not cover.** Gitee, self-hosted deployments, domestic models. Untested; needs conversations before code.
