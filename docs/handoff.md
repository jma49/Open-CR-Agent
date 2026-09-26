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
| Architecture | `docs/architecture.md`, decisions in `docs/adr/0001`–`0006`, spike report `docs/spikes/0001-opencode-runtime.md` |
| Audits | `docs/audits/` (latest: `2026-09-26-self-audit.md`) |
| Pitfalls | `docs/pitfalls.md` |
| User manual | `docs/manual/{en,zh}` (rendered by the site; manual changes on `main` redeploy it) |

## Status

**M1 (local review MVP): done except the benchmark baseline.** 225 tests pass (`npm run verify`).

Working end to end: `ocra review` on the working tree, a range (`--from/--to`) or a commit, through select → triage → bundle (light-model grouping) → review (OpenCode runtime, read-only MCP tools, 20-step cap, model failback) → anchor → report (text/JSON, JSONL session log, exit codes). Everything is wired through the plugin host (ADR-0006). `ocra-eval` replays AACR-Bench with the official matching rules.

Open work:

- **Audit follow-ups (do these first).** The 2026-09-26 self-audit found that agents can read secret files such as `.env` (#32, P0) and that repository plugins execute during `ocra-eval` runs on third-party clones (#33, P0). Then #34–#39. Ranked list in `docs/audits/2026-09-26-self-audit.md`, section 4.

- **#12 baseline.** Harness is merged; the 20-PR baseline (`ocra-eval run --limit 20 --max-change-lines 300 --label baseline --max-cost-usd 5`) is blocked on API quota. A 3-PR smoke run (before grouping and off-bundle filtering existed) gave precision 25%, recall 6.7%, $0.17; compare against it.
- **M2 (next):** security and performance reviewers, review matrix (which reviewers per bundle, by tier and paths), Verify, Judge (cross-bundle semantic dedup, verdict), risk-tier routing. Orchestration can be built and tested with fake runtimes.
- **M3:** `vcs-github` adapter (currently a stub), inline comments, verdicts, incremental re-review, GitHub Action. CI must read `.ocra/config.json`, rules and plugins from the trusted base branch (ADR-0006).
- **M4:** circuit breakers, remote config, review memory, `--ultra`.

## Environment notes

- **Model key:** `GEMINI_API_KEY` is exported in the maintainer's `~/.zshrc`. Agent shells capture the environment at session start, so a key added later is not visible; load just that line without printing it: `eval "$(grep -E '^export GEMINI_API_KEY=' ~/.zshrc)"`.
- **Quota:** the key hit quota limits on `gemini-3.8-flash` and `gemini-3.5-flash`; `gemini-flash-lite-latest` still worked last time. Do not run the baseline until quota is confirmed.
- **Model chain:** `.ocra/config.json` lists `gemini-3.8-flash` first, but 3.8-flash fails inside OpenCode's step loop (400 "Requests ending with a model turn") and costs ~$0.02 and ~20 s before failing over. Undecided whether to reorder; the maintainer was asked.
- **Secrets:** `SITE_DEPLOY_HOOK` (main repo, Vercel deploy hook for the site). No other secrets are configured. Never print or commit secret values.
- **Git identity:** commits as `jincheng_m <majincheng990128@gmail.com>`.
- **Vercel connector:** the claude.ai Vercel connector's authorization is broken ("User not found", sees no projects). Use the Vercel dashboard or `npx vercel login` + CLI instead.
- **Browser automation:** the Chrome extension has no permission to screenshot `ocra-nine.vercel.app`; verify visuals on a local `next start`.

## Traps and rules

Everything that already bit us (OpenCode quirks, git, eval, tooling, the site) is in [docs/pitfalls.md](pitfalls.md); the rules that follow from them are in `AGENTS.md` under "Engineering best practices". Read both before touching the runtime, git or eval code.

## Known gaps and trade-offs

- Anchoring's LLM relocation step exists in core but is not wired into the CLI (documented as planned).
- Findings anchored outside a task's bundle are dropped (precision first); semantic cross-bundle dedup waits for the Judge.
- The runtime has no live integration test in CI (needs a model key); behavior is covered by unit tests plus a test against the real OpenCode binary without a model.
- `vcs-github` is a stub; `LocalGitAdapter` is the only working VCS adapter.

## Open questions for the maintainer

1. Reorder the `standard` model chain so a working model comes first? (The audit recommends yes, finding P5.)
2. "ORCA" was mentioned during the site redesign; the name was kept as `ocra`. Confirm whether a rename was intended.
3. Next milestone: M2 or M3 first? The audit recommends baseline → Verify → a minimal GitHub Action → rest of M2 (section 3).
