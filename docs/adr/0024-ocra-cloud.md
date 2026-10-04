# ADR-0024: ocra Cloud, an account-based product on the open engine

- Status: accepted
- Date: 2026-10-04

## Context

The maintainer wants ocra to be a product people can start using in minutes, and a business. Today a user installs the CLI, finds the right environment variable for their provider's key, and writes `.ocra/config.json` with three model tiers before the first review; the GitHub Action adds a workflow file and a repository secret. Every step loses people, and the data that would improve ocra (findings, dismissals, replies) stays on each user's machine, so the project's only data is its own dogfood.

Tools users already know show the other shape: Claude Code runs locally and logs in to an account that carries models, usage and settings; CodeRabbit, Sentry, GitLab and PostHog pair an open core with a hosted service. The roadmap had a control plane (M14) in its Next phase; the maintainer moved it to the main line on 2026-10-04, and decided that the first version supports only the user's own model key (BYOK): ocra pays for no model calls.

What must not change: the open engine is the product's foundation and its credibility. The CLI, the Action and the container image stay Apache-2.0, work without any account, and keep every security property in the threat model.

## Decision

**ocra becomes open core plus ocra Cloud.** The engine, CLI, Action and image stay as they are, fully usable without an account. ocra Cloud is an optional hosted service built on the published packages, in its own private repository (`jma49/ocra-cloud`), never a fork of the engine: each review it runs is a call of the `review()` entry.

**Phase 1 (the MVP): an account, the user's key in the cloud, and a web view of the reviews.**

1. **Account.** Sign-in with GitHub (OAuth) on the web; Phase 1 accounts are single users. The CLI logs in with the OAuth device flow (`ocra login`, RFC 8628): the web shows the user code for the user to confirm, the code expires within minutes, polling is rate-limited, and the grant is bound to the signed-in GitHub account. The CLI receives a token of its own, short-lived with a refresh token, scoped to the gateway and the upload API only (never account settings or keys), revocable from the web, stored in the OS keychain or a `0600` file. `ocra logout` and `ocra whoami` complete the set.
2. **The key stays in the cloud, behind a model gateway.** The user enters a provider key once on the web. It is stored with envelope encryption (a data key per secret under a master key the application never logs), shown masked afterwards and never returned to any client. The CLI does not fetch it: it calls ocra Cloud's gateway, which speaks the OpenAI chat completions API, attaches the user's key on the server, forwards to the provider and streams the answer back. To the engine the gateway is a declared OpenAI-compatible provider (ADR-0017) used by the `direct` runtime (ADR-0020), so the engine needs no new runtime. Its invariants:
   - **A forwarder, not a relay.** It forwards only to the providers and models the user configured on the web, to URLs fixed on the server; it never takes a base URL, header or host from the client. This closes server-side request forgery and open-relay use.
   - **No bodies are logged or stored**, request or response, an invariant with a test; it records per-call metadata (model, tokens, latency, status) for the usage view.
   - **Limits.** Streaming passthrough, an upstream timeout, per-user concurrency and request-rate limits, and a daily token or dollar cap the user sets; the provider's own spending limit stays the user's backstop.
   - **One credential.** It accepts only the CLI token (and, in Phase 2, the App's job identity), never the provider key from a client, and refuses anonymous use.
   - **Audit.** Every use of a key is recorded in an audit log the user can read.
   - **It sees the code in transit.** For a logged-in user the code passes through the gateway on its way to the provider, so the engine's promise that only the model provider sees the code holds only without a login.
3. **Zero configuration when logged in.** With a login and no models configured, the CLI uses the gateway with the models the user picked on the web. A repository's `.ocra/config.json` still wins, and an organization policy (ADR-0022) still caps both.
4. **Reviews in the web view.** After a review, a logged-in CLI uploads, by default, metadata only: run id; the repository as a salted hash plus a label the user may set (names of private repositories are confidential); verdict, coverage counts, tokens, cost and duration; and per finding its fingerprint, reviewer, category, severity, verification, line range, status and title (model text, neutralized as in posted comments), plus whether reviewers dismissed or answered it. The opt-in tier, "share review content", which the data flywheel asks for and the user may refuse, adds file paths (they reveal the architecture), finding bodies, quoted code, and the text of dismissals and replies. `--no-upload` and `OCRA_CLOUD=off` turn uploading off for a run; the CLI says when it uploads and what.
5. **The web.** The reviews, a review with its findings, statistics over time (what `ocra metrics` computes: verdicts, findings by severity and verification, acceptance and dismissal per reviewer, cost), keys and model choice, and CLI sessions with revocation.

**Phase 2: a hosted GitHub App.** Installing the App is the whole setup: webhooks queue jobs, workers run `review()` on the pull request with the installation's token and the user's key through the gateway, and post as the App. No workflow file, no secret. The trust rules of the review conversation (ADR-0016) and the untrusted-pull-request properties (ADR-0013) carry over unchanged. Where and how workers run (isolation per job, egress limited to the gateway and the platform) is its own ADR.

**Phase 3: models ocra provides.** A free allowance and paid plans, through the same gateway, so a user with no key can start. Not before the maintainer decides a model budget.

**Data policy, stated on a public page before Phase 1 ships.** What is stored (account, encrypted keys, review metadata, opted-in content), what is not (code, unless shared; request bodies), retention (review data 90 days by default), export, deletion per review and per account within a stated time that also destroys the account's data keys, that nothing is used to train models, the hosting region, and the subprocessors (the hosting platform, the database provider, and the model providers the user chose). A minimal incident process (who rotates the master key, revokes tokens and tells users) exists before the first external user. The threat model gains a cloud section: a breach of the service exposes encrypted keys and metadata; the master key lives apart from the database; users are told to set a spending limit at their provider; key use is in an audit log the user can read.

**Stack for Phase 1** (one maintainer, little money): Next.js on Vercel, which the project already uses; Postgres from a managed provider; Auth.js with the GitHub provider; AES-256-GCM envelope encryption with the master key in the platform's encrypted environment, moving to a key management service before paid plans, and master-key rotation (re-wrapping every data key) designed in Phase 1 even if run by hand. Conditions:
- **Isolation:** every query goes through one data-access layer that filters by account, with a test per table that one account cannot read another's rows.
- **Long streams:** a review task can stream for ten minutes or more; the gateway runs where that is allowed (checked against the platform's function limits before Phase 1 is committed), or reviews fail mid-task.

Expected cost: tens of dollars a month.

**What the open repository gets in Phase 1:** `ocra login`, `ocra logout`, `ocra whoami`; the gateway as a built-in provider when logged in; the upload after a review, off by default unless logged in, with `--no-upload`; the manual's pages on what ocra Cloud receives. Nothing the cloud needs becomes a hidden dependency: a self-hosted user never sees a login prompt.

## Consequences

Reviewed with Claude Fable 5.1, whose conditions on custody, upload scope, phasing, stack and security are written into the Decision above.


- The fastest start becomes: install, `ocra login`, add a key on the web, `ocra review`. Phase 2 makes it: install the App.
- Data from every logged-in user's reviews, at least their metadata and their dismissals, reaches the project: the flywheel stops depending on dogfood alone. The opt-in for content decides how much it can learn.
- Code passes through ocra Cloud's gateway on its way to the provider. The engine's promise, that nothing but the model provider sees the code, holds only for users who do not log in; the manual and the data policy must say so plainly, and enterprise users keep the self-hosted path.
- ocra now runs a service: uptime, incidents, key custody, account deletion and abuse are the maintainer's job. One maintainer is a risk the roadmap's governance item already names.
- The roadmap's M14 moves from Next to Now as "ocra Cloud", phased as above; M13 (external users) uses it as the onboarding path. The local `ocra ui` idea is dropped in favour of the web view; `ocra init` and `ocra doctor` stay for self-hosted users.
- Organizations (teams, shared keys, policy) arrive in Phase 2 with the App, which installs on an organization; Phase 1 is single-user.
- Open questions for the phases' own ADRs: worker isolation, webhook verification and installation tokens for the hosted App (Phase 2); the key management service and regions; billing (Phase 3).
- With one maintainer, the service can stop; export and deletion in the data policy keep users from being trapped, and the engine keeps working without the service.
