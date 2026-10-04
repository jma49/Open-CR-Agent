# Handoff

The current state of the project, for whoever picks it up next (human or agent). **Rewrite this file, do not append to it:** replace what changed, delete what is done, keep one list of next steps. History lives in git, `CHANGELOG.md` and `docs/audits/`. Keep it under about 150 lines.

Last rewritten: 2026-10-03.

## Where things live

| What | Where |
|---|---|
| Repositories | https://github.com/jma49/Open-CR-Agent (public, Apache-2.0); the site at https://github.com/jma49/ocra-site |
| Live site | https://ocra.majincheng.com (English at `/`, Chinese at `/zh`). No automatic deploys: `VERCEL_SCOPE=<team> npm run deploy` in the site repository; the agent may deploy (team in `.local/agent-notes.md`) |
| Rules | `AGENTS.md` in each repository (`CLAUDE.md` imports it); the site's design rules in its `DESIGN.md` |
| Direction and plan | `docs/roadmap.md` (no deadlines: Now, Next, Later) |
| Architecture | `docs/architecture.md`; decisions in `docs/adr/` (index: `docs/adr/README.md`); spikes in `docs/spikes/` |
| Traps | `docs/pitfalls.md` (read before touching the runtime, git, eval or release code) |
| Checks that need a deploy, a key or an account | `docs/pending-verification.md` |
| Releasing | `docs/releasing.md`, `scripts/release.mjs`, `.github/workflows/release.yml`; notes in `CHANGELOG.md` |
| Measured quality | `docs/manual/{en,zh}/quality.mdx`; the golden set in `evals/golden/` (22 cases) |
| Security | `SECURITY.md` (GitHub private reporting); the latest audit `docs/audits/2026-09-30-m9-security.md` |
| npm | Organization `open-cr-agent` (owner `majincheng_ocra`, two-factor with a security key). Published with trusted publishing from `release.yml`: `core`, `runtime-opencode`, `vcs-platform`, `vcs-github`, `vcs-gitlab`, `vcs-local`, `cli`. **Not yet published: `runtime-direct`** (below) |
| Container image | `ghcr.io/jma49/ocra:<version>`, public, attested (0.2.0 is `sha256:89db7d33…`) |
| Machine and tooling notes | `.local/agent-notes.md` (git-ignored: keys, shell quirks, connectors, dogfood setup) |

## Current state

- **Released:** v0.2.0 (2026-09-30): GitLab, SARIF out, the container image, declared OpenAI-compatible providers, and the M9 security audit's fixes.
- **On `main` since 0.2.0, unreleased** (see `CHANGELOG.md`, Unreleased):
  - M10 contracts: the Finding specification and the report's JSON Schema (ADR-0018); SARIF in, `--import-sarif` (ADR-0019); the `review()` entry and the manual's Embedding page; the `direct` runtime with the runtime conformance suite (ADR-0020); proposed records for the reviewer entity (ADR-0021) and the organization policy (ADR-0022).
  - M12: one run id across session, report, output, summary comment and SARIF; `ocra metrics`.
  - M11: `nightly-live.yml`, a nightly live review on a free OpenRouter model with the `direct` runtime.
  - Fixes: quoted code left as written in posted text (#302); the eval checkout on git 2.43 (#301); proxy variables honored where Node's `fetch` ignores them.
- **Roadmap (2026-10-03):** deadlines removed at the maintainer's request; external use (M13) starts now, alongside M10–M12.
- **Open:** no pull requests. Issues #289 and #290, both waiting on the maintainer (below).
- **Tests:** `npm run verify` green on `main`.

## Maintainer actions

1. **Before the next release: publish `@open-cr-agent/runtime-direct` once by hand, then trust the workflow.** `cli` depends on it, and npm accepts a trusted publisher only for a package that exists, so a release fails at it until then (`docs/releasing.md`, Adding a package). The agent can run the publish under a pseudo-terminal while the maintainer confirms in the browser; `npm trust github @open-cr-agent/runtime-direct --file release.yml --repo jma49/Open-CR-Agent --allow-publish --yes` and `npm access set mfa=publish @open-cr-agent/runtime-direct` are the maintainer's to run.
2. **For the live GitLab check and #290:** a scratch group with a project on gitlab.com and a project access token (Developer role, `api` scope), put in `.local/`. Costs no model credit.
3. **For #289:** a GitHub App on a scratch repository, or a go-ahead for the agent to create one.
4. Optional: a contact address for conduct and security reports (GitHub private reporting today).
5. Optional: delete the unused `SITE_DEPLOY_HOOK` secret.

## Next steps for the agent

In order; none needs paid credit.

1. **The nightly live smoke fails at the model.** The scheduled run of 2026-10-03 failed with "the endpoint's answer is not a chat completion" for `stealth/space-bunny-alpha`: the free preview may have changed or ended. Check the model on OpenRouter, switch `nightly-live.yml` to a free model that answers, and record the change.
2. **Release 0.3.0** once maintainer action 1 is done: the unreleased M10–M12 work above (`docs/releasing.md`, Later releases).
3. **External use (M13):** get three teams on the Action or the GitLab job. Make the first run easy: a short "try it in five minutes" path in the README and the manual, and a free-model recipe that needs no paid key.
4. **The free-model evaluation** (M11): the golden smoke tier twice on the free model, one lane at a time (OpenRouter's free quota is 1000 requests a day, about one smoke tier), then the quality page with its numbers, marked as not comparable with the Vertex runs (different judge). The run directories from 2026-10-02 lived in a cloud session and are not on this machine.
5. **M10 leftovers:** sinks (one contract for the platform and SARIF); the reviewer entity (ADR-0021) and organization policy (ADR-0022) when their first customer appears; the curated `core` export surface when the maintainer says.
6. After maintainer actions 2 and 3: the live GitLab check, #290, #289.

## Budget

- **Vertex (Google Cloud trial credit):** the maintainer's floor is $100 left ("还剩100的时候就别再花额度了"). Last known (2026-09-30): evaluation $6.18 above the floor; dogfood ocra $19.70, jmos $5.39, Assay $2, vouch $2. Estimate every paid run first, start with the smallest probe, report tokens and dollars after.
- **Free:** OpenRouter's free models (the maintainer's key is the repository secret `OPENROUTER_API_KEY` and a credential of the cloud environment; none is set up on the MacBook). Prefer them for anything a free model can answer.
- **Dogfood:** `OCRA_REVIEW=on` in this repository, `$2` of review starts a day; a skipped review says why in the job summary. Stop with `gh variable set OCRA_REVIEW --body off`. Setup details in `.local/agent-notes.md`.

## Authority

The maintainer delegated full authority on 2026-09-30 ("你自己合并就可以。全权交给你"): the agent merges its own green pull requests, releases and decides scope, and reports what it did. Decisions go to Claude Fable 5.1 when they shape the product. The credit floor binds. The agent never runs `npm trust`, `npm access`, `npm org` or `npm dist-tag`; it runs `npm publish` only at the maintainer's request.

## Known gaps

- **Quality evidence is thin:** 22 golden cases, few runs, agent labels spot-checked by a second model. One run cannot tell an effect from noise.
- **Live coverage:** GitLab is tested against a fake API only; the `direct` runtime has not been evaluated against OpenCode; the fork recipe and the push-access-proof GitHub setup have not run end to end.
- **Recall** is the gap, lost at the reviewers; prompts stay frozen until M11's numbers can measure a change.
- **Memory** matches by fingerprint, so code that moves files or a model quoting different lines makes a finding new again.
- **The judge sees findings, not code;** it is told to be conservative.
- With the OpenCode runtime, OpenCode still fetches its pricing catalog at start; its npm installs go to a refusing local registry (#281). The `direct` runtime reaches only the model endpoint.

## Open questions for the maintainer

1. ADR-0021 (reviewer entity) and ADR-0022 (organization policy) are proposed. Accept, change or hold; the agent holds both until a first customer needs them.
2. Assay's and vouch's dogfood budgets are $2 each (they were $12); raise them before switching either on.
3. The 6 golden labels and 11 expected issues not yet spot-checked: check by a second model, or leave.
