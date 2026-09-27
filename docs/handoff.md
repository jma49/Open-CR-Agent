# Handoff

State of the project as of 2026-09-27, for whoever picks it up next (human or agent). Update this file at the end of each working session; keep it about *state and next steps*, not history (git has the history).

## Where things live

| What | Where |
|---|---|
| Main repository | https://github.com/jma49/Open-CR-Agent (public, Apache-2.0) |
| Site repository | https://github.com/jma49/open-cr-agent-site (public) |
| Live site | https://ocra-nine.vercel.app (English at `/`, Chinese at `/zh`) |
| Vercel project | `ocra`; no automatic deploys, deploy by hand from the site repo (`npm run deploy`) |
| Contributor rules | `AGENTS.md` in each repository (`CLAUDE.md` imports it) |
| Architecture | `docs/architecture.md`, decisions in `docs/adr/0001`–`0010`, spike report `docs/spikes/0001-opencode-runtime.md` |
| Audits | `docs/audits/` (latest: `2026-09-27-audit.md`) |
| Pitfalls | `docs/pitfalls.md` |
| Pending verification | `docs/pending-verification.md` (what still needs a deploy or a model key to check) |
| Releasing | `docs/releasing.md` (npm: what is ready, decisions, steps) |
| User manual | `docs/manual/{en,zh}` (rendered by the site; changes reach the live site only when the site is deployed) |

## Status

**M1–M4 are implemented; none of the model-dependent quality is measured yet.** ~350 tests pass (`npm run verify`).

Pipeline today: ingest → select → triage → bundle → **matrix** (reviewer scopes, risk tiers, overrides; ADR-0007) → review (correctness, security, performance; OpenCode runtime, read-only MCP tools, 20-step cap, per-model circuit breaker) → anchor → memory (`.ocra/memory.json`) and re-review reconciliation → **verify** (drops only findings the code disproves, marks the rest confirmed/uncertain/unchecked) → **judge** (merge, drop, recalibrate on the top tier) → verdict by a fixed rubric (only verified critical findings block) → report. Pull requests: `ocra review --pr [--publish]` and `action.yml` (ADR-0008) with inline comments, one summary comment, thread resolution only when the anchored code is gone (ADR-0009), incremental re-review of what changed since the last reviewed head (ADR-0010, `--full` to override), and respect for human dismissals; trusted inputs come from the base commit. `fail-on-concerns` defaults to off: the verdict is advice, not a security gate. Also: `--ultra`, `--reviewers`, `--max-cost-usd`, `--no-repo-config`, `extends` (shared config over https), Ctrl-C handling, exit codes 0/1/2/3/130. The 2026-09-26 audit's P0/P1 findings (#32–#39) are fixed, but the 2026-09-27 audit found the secret guard bypassable through symlinks (#104) and other gaps (below).

**Model use is tightly budgeted.** The Gemini key is on the free tier and the maintainer will not enable billing. `gemini-3.5-flash` on the free tier allows about 20 requests a day (one small pull request), so quality evaluation (baseline, `[needs-eval]` PRs) is blocked; flash-lite runs of 1–2 PRs are for checking mechanics only. A Gemini key is available for local runs only (never as a CI secret without the maintainer's approval). Spend as little as possible: prove things with the smallest probe first, estimate and report the cost of every run, and ask before any evaluation larger than a few PRs. Free work (`ocra review --plan`, `ocra-eval ceiling`, tests, docs, local site builds) still comes first. `docs/pending-verification.md` lists the model-dependent work in order.

**What we know without a model:** `ocra-eval ceiling --limit 100 --max-change-lines 300` (94 PRs, 530 annotated issues) puts the recall ceiling of ocra's deterministic stages at **57.7%**. 40.0% of the benchmark's issues are maintainability and readability, which ocra does not report by design; selection and the review matrix lose 6 issues (1.1%), and #76 addresses the security ones. So on AACR-Bench, recall above ~58% is impossible whatever the model, and precision is where ocra should be judged.

**2026-09-26 fix round** (from an external review of `3b04126`), merged:

| Task | PR | What |
|---|---|---|
| A1 | #78 | `gemini-3.8-flash` out of the chains; LFS checkout on git 2.43 |
| A2 | #79 | Fixed only when the anchored code is gone; category from the reviewer; unreproduced findings stay open (ADR-0009) |
| A3 | #80 | Only verified critical findings block; judge cannot drop them; `fail-on-concerns` off by default |
| A4 | #81 | Memory and dismissals before Verify; 20% of `--max-cost-usd` reserved for Verify and Judge |
| A5 | #82 | Architecture marks planned parts; machine-local notes moved to git-ignored `.local/` |
| A6 | #83 | Incremental re-review (ADR-0010) |

**Open, not merged, waiting for an eval (`[needs-eval]`):** #84 (B1, `ocra_` prompt tags), #85 (B2, security reviewer at every tier; free ceiling: security reachable 13 → 16 of 18), #86 (B3, strict anchoring; also fixes most of the 2026-09-27 audit's anchoring findings), #103 (#76, security words in paths force `full`; free ceiling: 2 of 94 PRs move to `full`, security reachable 13 → 14 of 18). Each changes what models see or which findings are reported; `docs/pending-verification.md` says what to measure. They touch some of the same test files; rebase each on `main` before merging.

**Site (2026-09-26/27):** redesigned (monochrome, Aquamarine brand, a 3D voxel frog mascot in three.js) and refreshed section by section (animated pipeline walk-through, pull request thread with its states, illustrated decisions, CLI/Action tabs, section rhythm, roadmap timeline); the manual uses Steps, Cards and Callouts. An exploratory QA pass (separate agent, all pages, 4 widths, both themes, reduced motion on/off) found 17 issues; all fixed and re-tested (site #20, main #98), including a hydration error on every English docs page and broken Edit-on-GitHub links. **Live since 2026-09-27** at https://ocra-nine.vercel.app (site `2693463` plus the deploy script). **Nothing deploys automatically** (site `vercel.json`: `git.deploymentEnabled: false`), and deploy hooks do not run while Git deployments are off (verified: a triggered hook created no deployment), so `site-deploy.yml` was removed. Deploy, only when the maintainer asks, with `VERCEL_SCOPE=<team> npm run deploy` in the site repository (deploys its committed HEAD through a logged-in Vercel CLI; one build per run).

Open work, in order:

1. Free, from the [2026-09-27 audit](audits/2026-09-27-audit.md), in order: #104 (P0, symlinks bypass the secret guard in workspace mode), #116 (judge must not downgrade a confirmed critical), #117 (exit 3 when a critical finding could not be verified), #105 (summary state: path injection, edited dismissals, size), #108 (runs that reviewed nothing read as approved), #109 (Node fetch 300 s cut-off, lost cost of timed-out tasks), #106, #107, #110, #111, #112 (vacuous tests), then #113 (docs) and #114 (P2). `ocra-eval ceiling` now also prints the tier mix (#101).
2. Model-dependent, in order: #66 is fixed (helper agent needs two steps on Gemini); next the #12 baseline with a model stronger than flash-lite, then the `[needs-eval]` PRs #84–#86, then measuring the new reviewers, Verify, Judge, the budget reserve and `--ultra`, then #67 (the Action on a live pull request).
3. Not implemented from the architecture (marked planned there): the `docs` and `agents-md` reviewers; `--ultra`'s plan phase and caller impact analysis; the judge reassessing findings a reviewer disagrees with; LLM relocation in anchoring (exists in core, not wired); inactivity detection.
4. Publishing to npm: ready and checked in CI; the maintainer decides scope and timing (`docs/releasing.md`).

## Environment notes

- **Model key:** a free-tier Gemini key is available for local runs only (never as a CI secret); billing will not be enabled, so quality evaluation waits for a paid key or another provider. How to load it is in `.local/agent-notes.md`. The runtime names a missing key instead of failing with "model not found".
- **Models for evaluation:** `gemini-flash-lite-latest` is too weak to evaluate prompts (see #12); use a Flash or Pro class model.
- **Model chain:** `gemini-3.8-flash` was removed from the dogfood `.ocra/config.json` and the README example: it fails inside OpenCode's step loop (400 "Requests ending with a model turn") and cost ~$0.02 and ~20 s per run before failing over.
- **Secrets:** `SITE_DEPLOY_HOOK` (main repo) is no longer used since `site-deploy.yml` was removed; the maintainer may delete it. No other secrets are configured. Never print or commit secret values.
- **Vercel build limit:** the Hobby plan rate-limits builds. Every manual change on `main` triggers a site build, and on 2026-09-26 ~15 such merges exhausted it ("retry in 24 hours"); the site's latest copy deploys on the next build.

## Traps and rules

Everything that already bit us (OpenCode quirks, git, eval, tooling, the site) is in [docs/pitfalls.md](pitfalls.md); the rules that follow from them are in `AGENTS.md` under "Engineering best practices". Read both before touching the runtime, git or eval code.

## Known gaps and trade-offs

- Quality is unmeasured (see Status). Verify and Judge fail safe, so the worst case of a broken model call is today's behavior, not lost findings.
- The judge sees findings, not code; it is told to be conservative and never to drop a finding only because it doubts it.
- `.ocra/memory.json` matches by fingerprint (reviewer category, file, normalized quoted code): moving the code to another file, or the model quoting different lines, makes the finding new again. Re-review no longer calls such findings fixed (ADR-0009), but memory still misses them.
- The runtime has no live integration test in CI (needs a model key); behavior is covered by unit tests, a test against the real OpenCode binary without a model, and a faked GitHub API.

## Open questions for the maintainer

1. npm publishing: when, and token vs trusted publishing (`docs/releasing.md`). The scope is decided: `@open-cr-agent`.
