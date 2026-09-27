# Handoff

State of the project as of 2026-09-26, for whoever picks it up next (human or agent). Update this file at the end of each working session; keep it about *state and next steps*, not history (git has the history).

## Where things live

| What | Where |
|---|---|
| Main repository | https://github.com/jma49/Open-CR-Agent (public, Apache-2.0) |
| Site repository | https://github.com/jma49/open-cr-agent-site (public) |
| Live site | https://ocra-nine.vercel.app (English at `/`, Chinese at `/zh`) |
| Vercel project | `ocra`; deploys the site repo's `main` through the deploy hook |
| Contributor rules | `AGENTS.md` in each repository (`CLAUDE.md` imports it) |
| Architecture | `docs/architecture.md`, decisions in `docs/adr/0001`–`0008`, spike report `docs/spikes/0001-opencode-runtime.md` |
| Audits | `docs/audits/` (latest: `2026-09-26-self-audit.md`) |
| Pitfalls | `docs/pitfalls.md` |
| Pending verification | `docs/pending-verification.md` (what still needs a deploy or a model key to check) |
| Releasing | `docs/releasing.md` (npm: what is ready, decisions, steps) |
| User manual | `docs/manual/{en,zh}` (rendered by the site; manual changes on `main` redeploy it) |

## Status

**M1–M4 are implemented; none of the model-dependent quality is measured yet.** ~350 tests pass (`npm run verify`).

Pipeline today: ingest → select → triage → bundle → **matrix** (reviewer scopes, risk tiers, overrides; ADR-0007) → review (correctness, security, performance; OpenCode runtime, read-only MCP tools, 20-step cap, per-model circuit breaker) → anchor → memory (`.ocra/memory.json`) and re-review reconciliation → **verify** (drops only findings the code disproves, marks the rest confirmed/uncertain/unchecked) → **judge** (merge, drop, recalibrate on the top tier) → verdict by a fixed rubric (only verified critical findings block) → report. Pull requests: `ocra review --pr [--publish]` and `action.yml` (ADR-0008) with inline comments, one summary comment, thread resolution only when the anchored code is gone (ADR-0009), incremental re-review of what changed since the last reviewed head (ADR-0010, `--full` to override), and respect for human dismissals; trusted inputs come from the base commit. `fail-on-concerns` defaults to off: the verdict is advice, not a security gate. Also: `--ultra`, `--reviewers`, `--max-cost-usd`, `--no-repo-config`, `extends` (shared config over https), Ctrl-C handling, exit codes 0/1/2/3/130. The 2026-09-26 audit's P0/P1 findings (#32–#39) are fixed.

**Model use is tightly budgeted.** A Gemini key is available for local runs only (never as a CI secret without the maintainer's approval). Spend as little as possible: prove things with the smallest probe first, estimate and report the cost of every run, and ask before any evaluation larger than a few PRs. Free work (`ocra review --plan`, `ocra-eval ceiling`, tests, docs, local site builds) still comes first. `docs/pending-verification.md` lists the model-dependent work in order.

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

**Open, not merged, waiting for an eval (`[needs-eval]`):** #84 (B1, `ocra_` prompt tags), #85 (B2, security reviewer at every tier; free ceiling: security reachable 13 → 16 of 18), #86 (B3, strict anchoring). Each changes what models see or which findings are reported; `docs/pending-verification.md` says what to measure. They touch some of the same test files; rebase each on `main` before merging.

Open work, in order:

1. Free: #76 (wider sensitive-path triage, measured with `ocra-eval ceiling`).
2. Model-dependent, in order: #66 is fixed (helper agent needs two steps on Gemini); next the #12 baseline with a model stronger than flash-lite, then the `[needs-eval]` PRs #84–#86, then measuring the new reviewers, Verify, Judge, the budget reserve and `--ultra`, then #67 (the Action on a live pull request).
3. Not implemented from the architecture (marked planned there): the `docs` and `agents-md` reviewers; `--ultra`'s plan phase and caller impact analysis; the judge reassessing findings a reviewer disagrees with; LLM relocation in anchoring (exists in core, not wired); inactivity detection.
4. Publishing to npm: ready and checked in CI; the maintainer decides scope and timing (`docs/releasing.md`).

## Environment notes

- **Model key: none.** Nothing that calls a model can run until the maintainer provides a key. The runtime names a missing key instead of failing with "model not found".
- **Models for evaluation:** `gemini-flash-lite-latest` is too weak to evaluate prompts (see #12); use a Flash or Pro class model.
- **Model chain:** `gemini-3.8-flash` was removed from the dogfood `.ocra/config.json` and the README example: it fails inside OpenCode's step loop (400 "Requests ending with a model turn") and cost ~$0.02 and ~20 s per run before failing over.
- **Secrets:** `SITE_DEPLOY_HOOK` (main repo, Vercel deploy hook for the site). No other secrets are configured. Never print or commit secret values.
- **Vercel build limit:** the Hobby plan rate-limits builds. Every manual change on `main` triggers a site build, and on 2026-09-26 ~15 such merges exhausted it ("retry in 24 hours"); the site's latest copy deploys on the next build.

## Traps and rules

Everything that already bit us (OpenCode quirks, git, eval, tooling, the site) is in [docs/pitfalls.md](pitfalls.md); the rules that follow from them are in `AGENTS.md` under "Engineering best practices". Read both before touching the runtime, git or eval code.

## Known gaps and trade-offs

- Quality is unmeasured (see Status). Verify and Judge fail safe, so the worst case of a broken model call is today's behavior, not lost findings.
- The judge sees findings, not code; it is told to be conservative and never to drop a finding only because it doubts it.
- `.ocra/memory.json` matches by fingerprint (reviewer category, file, normalized quoted code): moving the code to another file, or the model quoting different lines, makes the finding new again. Re-review no longer calls such findings fixed (ADR-0009), but memory still misses them.
- The runtime has no live integration test in CI (needs a model key); behavior is covered by unit tests, a test against the real OpenCode binary without a model, and a faked GitHub API.

## Open questions for the maintainer

1. Provide a model key with quota (and say whether a stronger standard model, e.g. a Flash or Pro model, may be used for evaluation).
2. May a model key be added as a repository secret to dogfood the GitHub Action on this repository (#67)?
3. "ORCA" was mentioned during the site redesign; the name was kept as `ocra`. Confirm whether a rename was intended.
4. ~~Reorder the dogfood `.ocra/config.json` chain (audit P5)?~~ Decided: `gemini-3.8-flash` is removed from the chain and the README example.
5. Decisions taken in the fix round that deserve a look (details in each PR):
   - A2 (#79): findings whose file was not reviewed this time now count in the verdict; legacy state without a code hash is never auto-resolved; editing exactly the anchored lines counts as a fix.
   - A3 (#80): an unverified critical finding maps to `minor_issues` even with fewer than three warnings.
   - A4 (#81): the 80% review share is reasoned, not measured.
   - A6 (#83): a summary edited by anyone but ocra forces a full review; base-branch config or rule changes do not re-review unchanged files.
