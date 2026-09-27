# Handoff

State of the project as of 2026-09-26, for whoever picks it up next (human or agent). Update this file at the end of each working session; keep it about *state and next steps*, not history (git has the history).

## Where things live

| What | Where |
|---|---|
| Main repository | https://github.com/jma49/Open-CR-Agent (public, Apache-2.0) |
| Site repository | https://github.com/jma49/open-cr-agent-site (public) |
| Live site | https://ocra-nine.vercel.app (English at `/`, Chinese at `/zh`) |
| Vercel project | `ocra` in team `jonsons-projects`; deploys the site repo's `main` on push |
| Contributor rules | `AGENTS.md` in each repository (`CLAUDE.md` imports it) |
| Architecture | `docs/architecture.md`, decisions in `docs/adr/0001`–`0008`, spike report `docs/spikes/0001-opencode-runtime.md` |
| Audits | `docs/audits/` (latest: `2026-09-26-self-audit.md`) |
| Pitfalls | `docs/pitfalls.md` |
| Pending verification | `docs/pending-verification.md` (what still needs a deploy or a model key to check) |
| User manual | `docs/manual/{en,zh}` (rendered by the site; manual changes on `main` redeploy it) |

## Status

**M1–M4 are implemented; none of the model-dependent quality is measured yet.** ~300 tests pass (`npm run verify`).

Pipeline today: ingest → select → triage → bundle → **matrix** (reviewer scopes, risk tiers, overrides; ADR-0007) → review (correctness, security, performance; OpenCode runtime, read-only MCP tools, 20-step cap, per-model circuit breaker) → anchor → **verify** (drops only findings the code disproves) → memory (`.ocra/memory.json`) → re-review reconciliation → **judge** (merge, drop, recalibrate on the top tier) → verdict by a fixed rubric → report. Pull requests: `ocra review --pr [--publish]` and `action.yml` (ADR-0008) with inline comments, one summary comment, thread resolution, and respect for human dismissals; trusted inputs come from the base commit. Also: `--ultra`, `--reviewers`, `--max-cost-usd`, `--no-repo-config`, `extends` (shared config over https), Ctrl-C handling, exit codes 0/1/2/3/130. The 2026-09-26 audit's P0/P1 findings (#32–#39) are fixed.

Open work, in order:

1. **Get a working model key** (see Environment notes), then **#66**: `complete()` fails on Gemini ("Requests ending with a model turn"), so grouping, Verify and Judge currently fail safe and do nothing on Gemini.
2. **#12 baseline with a stronger standard model.** The flash-lite baseline found 1 issue in 17 PRs (precision/recall 0%): a floor, not a signal. Then measure Verify, Judge and the new reviewers against it, as AGENTS.md requires for prompt and stage changes (they were merged with unit tests only; PRs #52–#54 say so).
3. **#67**: exercise the GitHub Action on a live pull request (needs a model key as a repository secret; ask the maintainer before adding one).
4. Not implemented from the architecture: `--ultra`'s plan phase and caller impact analysis; the judge reassessing findings a person disagrees with; LLM relocation in anchoring (exists in core, not wired).
5. Publishing to npm (so `npx` works) once the above are verified.

## Environment notes

- **Model key: missing.** `GEMINI_API_KEY` was removed from `~/.zshrc` during the 2026-09-26 session and is in no other shell profile; nothing that calls a model can run until the maintainer provides a key. When it is back: agent shells capture the environment at session start, so load just that line without printing it: `eval "$(grep -E '^export GEMINI_API_KEY=' ~/.zshrc)"`. The runtime now names a missing key instead of failing with "model not found".
- **Quota:** with the old key, only `gemini-flash-lite-latest` answered; the Flash models returned empty responses. flash-lite is too weak to evaluate prompts (see #12).
- **Model chain:** `.ocra/config.json` lists `gemini-3.8-flash` first, but 3.8-flash fails inside OpenCode's step loop (400 "Requests ending with a model turn") and costs ~$0.02 and ~20 s before failing over. Undecided whether to reorder; the maintainer was asked.
- **Secrets:** `SITE_DEPLOY_HOOK` (main repo, Vercel deploy hook for the site). No other secrets are configured. Never print or commit secret values.
- **Git identity:** commits as `jincheng_m <majincheng990128@gmail.com>`.
- **Vercel connector:** the claude.ai Vercel connector's authorization is broken ("User not found", sees no projects). Use the Vercel dashboard or `npx vercel login` + CLI instead.
- **Browser automation:** the Chrome extension has no permission to screenshot `ocra-nine.vercel.app`, and screenshots of a local `next start` can time out; checking the DOM with JavaScript works.
- **Vercel build limit:** the Hobby plan rate-limits builds. Every manual change on `main` triggers a site build, and on 2026-09-26 ~15 such merges exhausted it ("retry in 24 hours"); the site's latest copy deploys on the next build.

## Traps and rules

Everything that already bit us (OpenCode quirks, git, eval, tooling, the site) is in [docs/pitfalls.md](pitfalls.md); the rules that follow from them are in `AGENTS.md` under "Engineering best practices". Read both before touching the runtime, git or eval code.

## Known gaps and trade-offs

- Quality is unmeasured (see Status). Verify and Judge fail safe, so the worst case of a broken model call is today's behavior, not lost findings.
- The judge sees findings, not code; it is told to be conservative and never to drop a finding only because it doubts it.
- `.ocra/memory.json` matches by fingerprint (category, file, normalized quoted code): moving the code to another file makes the finding new again.
- The runtime has no live integration test in CI (needs a model key); behavior is covered by unit tests, a test against the real OpenCode binary without a model, and a faked GitHub API.

## Open questions for the maintainer

1. Provide a model key with quota (and say whether a stronger standard model, e.g. a Flash or Pro model, may be used for evaluation).
2. May a model key be added as a repository secret to dogfood the GitHub Action on this repository (#67)?
3. "ORCA" was mentioned during the site redesign; the name was kept as `ocra`. Confirm whether a rename was intended.
4. Reorder the dogfood `.ocra/config.json` chain so a working model comes first (audit P5)? It still lists `gemini-3.8-flash` first.
