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
| Audits | `docs/audits/` (latest: `2026-09-27-full-audit.md`) |
| Pitfalls | `docs/pitfalls.md` |
| Pending verification | `docs/pending-verification.md` (what still needs a deploy or a model key to check) |
| Releasing | `docs/releasing.md` (npm: what is ready, decisions, steps) |
| User manual | `docs/manual/{en,zh}` (rendered by the site; changes reach the live site only when the site is deployed) |

## Status

**M1–M4 are implemented; none of the model-dependent quality is measured yet.** ~480 tests pass (`npm run verify`).

Pipeline today: ingest → select → triage → bundle → **matrix** (reviewer scopes, risk tiers, overrides; ADR-0007) → review (correctness, security, performance; OpenCode runtime, read-only MCP tools, 20-step cap, per-model circuit breaker) → anchor → memory (`.ocra/memory.json`) and re-review reconciliation → **verify** (drops only findings the code disproves, marks the rest confirmed/uncertain/unchecked) → **judge** (merge, drop, recalibrate on the top tier) → verdict by a fixed rubric (only verified critical findings block) → report. Pull requests: `ocra review --pr [--publish]` and `action.yml` (ADR-0008) with inline comments, one summary comment, thread resolution only when the anchored code is gone (ADR-0009), incremental re-review of what changed since the last reviewed head (ADR-0010, `--full` to override), and respect for human dismissals; trusted inputs come from the base commit. `fail-on-concerns` defaults to off: the verdict is advice, not a security gate. Also: `--ultra`, `--reviewers`, `--max-cost-usd`, `--no-repo-config`, `extends` (shared config over https), Ctrl-C handling, exit codes 0/1/2/3/130. The 2026-09-26 audit's P0/P1 findings (#32–#39) are fixed, and so is everything the 2026-09-27 audit found that does not change what models see (below); its prompt part waits for an eval (#126).

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

**2026-09-27 audit fix round**, merged ([audit](audits/2026-09-27-audit.md)):

| Issue | PR | What |
|---|---|---|
| #104 (P0) | #119 | Workspace reads never follow symlinks (a link reads as its target path, like `git cat-file`); renamed-away secrets refused; session logs never written through links; more secret patterns |
| #116 | #120 | The judge can neither drop nor downgrade a confirmed critical |
| #117 | #121 | A critical finding Verify could not check (failed, timed out, out of budget) makes the run exit 3; `verify: false` does not |
| #105 | #122 | Summary state trusted only when ocra last edited it (all fields); only a block ending the comment counts; dismissals never stored; state and comment size capped |
| #108 | #123 | Files not reviewed make the run exit 3; "Not reviewed" headline instead of "Approved"; one `coverageGaps` helper for every surface |
| #109 | #124 | undici fetch without the 300 s body timeout (`undici` dependency); cut-off sessions stopped and harvested; 10 s grace for late usage/findings; `CompletionError` carries failed helper spend |
| #106 (markdown) | #125 | Reference-style links in model text cannot resolve |
| #107 | #127 | Only `/ocra dismiss` or a reply opening with a clear decline dismisses |
| #110 | #128 | GitHub retries (rate limits always, 5xx only when safe); `requestChanges` withdrawn when no longer blocking; shallow-clone message; `concurrency` in the workflow docs |
| #111 | #129 | Tool answers capped (2,000 chars/line, 50,000/answer); `maxTasks` (default 60); directory bundling past 20 files without grouping; searches memoized; 2 MiB read cap; OpenCode output drained |
| #112 | #130 | Vacuous security tests replaced (each checked by a mutation) |
| #113 | #131 | Manual/architecture/ADRs match the code; `--no-repo-config` honoured with `--pr`; JSON output escapes C1 and bidi; `--plan` writes no session |
| #114 | #132–#135, this PR | Low-confidence out of state, `posted` comments remembered, diff-less files skip inline; most severe duplicate wins; `--ultra` coverage; forced-exit cleanup; git timeouts; action args/scripts/pins; eval commit ids |

Kept on purpose (the audit asked): an invalid `.ocra/rules.json` or `memory.json` still stops the run (tested and documented). Recorded, not fixed: a push that raises the risk tier does not re-review unchanged files with the new reviewers (ADR-0010 note), and a versioned JSON output type is due before the first npm release (`docs/releasing.md`).

**Open, not merged, waiting for an eval (`[needs-eval]`):** #126 (#106, prompt boundaries; the maintainer chose to merge only after an eval; a flash-lite mechanics probe on 3 PRs passed, quality needs a Flash-class run, see `docs/pending-verification.md`: `<ocra_…>` sections, per-field neutralization, look-alike coverage, `PromptText` type, neutralized tool results; supersedes #84, which is closed), #85 (B2, security reviewer at every tier; free ceiling: security reachable 13 → 16 of 18), #86 (B3, strict anchoring; also fixes most of the 2026-09-27 audit's anchoring findings), #103 (#76, security words in paths force `full`; free ceiling: 2 of 94 PRs move to `full`, security reachable 13 → 14 of 18). Each changes what models see or which findings are reported; `docs/pending-verification.md` says what to measure. Also waiting for an eval, the planned features built on 2026-09-27: #142 (`docs` reviewer), #143 (`agents-md` reviewer, with `requiresGuidelines` in the matrix), #144 (`--ultra` plan phase and callers of changed symbols), #145 (judge weighs people's replies to a finding), #146 (light-model relocation before file level). They touch some of the same files; rebase each on `main` before merging. When #126 lands first, the others' prompt text must move to its `<ocra_…>` tags and `PromptText`/`data()` (#144 adds `callers` and `review_plan` sections, #146 builds a relocation prompt, #142/#143 name `<review_files>`); #142 and #143 both extend `BUILTIN_PLUGINS` and its test.

**Site (2026-09-26/27):** redesigned (monochrome, Aquamarine brand, a 3D voxel frog mascot in three.js) and refreshed section by section (animated pipeline walk-through, pull request thread with its states, illustrated decisions, CLI/Action tabs, section rhythm, roadmap timeline); the manual uses Steps, Cards and Callouts. An exploratory QA pass (separate agent, all pages, 4 widths, both themes, reduced motion on/off) found 17 issues; all fixed and re-tested (site #20, main #98), including a hydration error on every English docs page and broken Edit-on-GitHub links. **Live since 2026-09-27** at https://ocra-nine.vercel.app (site `2693463` plus the deploy script). **Nothing deploys automatically** (site `vercel.json`: `git.deploymentEnabled: false`), and deploy hooks do not run while Git deployments are off (verified: a triggered hook created no deployment), so `site-deploy.yml` was removed. Deploy, only when the maintainer asks, with `VERCEL_SCOPE=<team> npm run deploy` in the site repository (deploys its committed HEAD through a logged-in Vercel CLI; one build per run).

Open work, in order:

1. Free: the second 2026-09-27 audit's findings are fixed and merged: #153 → #162 (exit code and coverage), #154 → #163 (commands from verified, unedited comments; write permission; full-SHA override), #155 → #164 (markdown in containers, path newlines, output escaping, finding caps), #156 → #165 (no steering files from untrusted code), #157 → #166 (reviewed head pinned; the action forwards cancellation), #159 → #167 (tests), #158 → #168 (runtime and eval edges), #160 → this PR (docs, `--plan` task-limit warning, contract key test, `npm run clean` before packing). #148 (CI baseline, from another session) stays open by the maintainer's decision; its audit notes are on the PR. #145 is updated to the maintainer's policy (2026-09-27): only replies from people with write access other than the author, in unedited comments, reach the judge, and they are keyed by fingerprint for every ocra thread, so a finding a reply dropped does not flip back the next run. It is rebased on `main` and still waits for #126 and an eval.
2. Model-dependent (decided 2026-09-27: wait until a billable key or another provider is available; do not run quality evals on the free tier), in order: #66 is fixed (helper agent needs two steps on Gemini); next the #12 baseline with a model stronger than flash-lite, then the `[needs-eval]` PRs #126, #85, #86 and #103, then measuring the new reviewers, Verify, Judge, the budget reserve and `--ultra`, then #67 (the Action on a live pull request).
3. Planned features: all built. The model-facing ones wait for an eval (#142–#146, #150 stacked on #144); the audit posted findings on each open PR and the merge order (#126 first) is in the audit.
4. Publishing to npm: ready and checked in CI; the maintainer decides scope and timing (`docs/releasing.md`).

## Environment notes

- **Model key:** a free-tier Gemini key is available for local runs only (never as a CI secret); billing will not be enabled, so quality evaluation waits for a paid key or another provider. How to load it is in `.local/agent-notes.md`. The runtime names a missing key instead of failing with "model not found".
- **Free-tier probe (2026-09-27):** `gemini-3.5/3.6/3.7/3.8-flash` and `gemini-flash-latest` answer with this key, each with its own daily quota; Pro models are refused (free-tier limit 0). Two one-PR runs (symfony@942f8fa, 24 lines, labels `quota-probe-1`/`-2`) reviewed nothing: 3.6 and 3.7 failed with "Requests ending with a model turn" after 10–11 tool calls, 3.5 was overloaded (503), flash-latest hit its per-minute limit, and the task timed out after 10 minutes. The blocker is #171, not quota; fix it before spending more requests. Each run used about 25–40 requests.
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
