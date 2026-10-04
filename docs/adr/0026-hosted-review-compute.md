# ADR-0026: Hosted reviews for the ocra Cloud GitHub App run in Cloudflare Containers

- Status: proposed
- Date: 2026-10-04

## Context

ADR-0024's Phase 2 is a hosted GitHub App: a team installs it and pull requests are reviewed with nothing to configure. A review clones the repository, runs `ocra review --pr` for 2 to 25 minutes, mostly waiting on model calls (through ocra Cloud's gateway), and posts the result. ocra Cloud's control plane is Cloudflare Workers and D1, which cannot run git or a 25-minute process. ADR-0024 left the compute and its budget to this record.

Requirements: one isolated environment per review, never shared between installations or reused; no tenant's data reachable from another; the repository is untrusted (ocra never executes its code, but cloning and git still carry risk); outbound network limited to what a review needs; a write token that the review environment does not have to hold; cost per review and idle cost small enough for a solo founder; little operations.

Researched 2026-10-04 (the private notes keep the sources): Cloudflare Containers and its Sandbox SDK, Fly Machines, Google Cloud Run Jobs, AWS Fargate and Lambda, Modal, E2B and Daytona, and running the review in the customer's own GitHub Actions. For a reference review of 10 minutes at 2 vCPU and 4 GB, the managed options cost between $0.003 (Fly, shared CPU) and $0.04 (Lambda, Modal); Lambda is ruled out by its 15-minute limit; Fly has no outbound allowlist; the customer's Actions costs us nothing but needs a workflow file and a secret in their repository and gives up control of versions and the experience.

## Decision

**Hosted reviews run in Cloudflare Containers, through the Sandbox SDK, one instance per review.**

1. **Webhooks.** The App subscribes to `pull_request` (opened, synchronize, reopened, ready_for_review, labeled) and `installation`. The Worker verifies `X-Hub-Signature-256` with a constant-time compare before parsing, answers within 10 seconds, and inserts a job row keyed by the delivery id (unique) and by (repository, pull request, head SHA): a duplicate is a no-op. A newer head supersedes a queued job for the same pull request. Draft pull requests are not reviewed. Jobs go through Cloudflare Queues with at most one retry, and only for a job that never reached publishing; the CLI's rule that it never repeats a request that may have posted a comment keeps a rerun safe.
2. **Who may start a review, and who pays.** ADR-0013's gate carries over unchanged: a pull request whose author is an owner, member or collaborator is reviewed on every push; anyone else's only when someone with write access adds the `ocra-review` label (checked through the API, never trusted from the payload). The payer is the ocra Cloud account linked to the installation, by a signed-in user whom GitHub lists as able to administer it; the provider keys spent are that account's (BYOK). Every review runs with `--max-cost-usd` (2 by default); each installation has a daily dollar cap and runs one review at a time.
3. **One sandbox per review, credentials outside it.** A queue consumer starts a Cloudflare Sandbox keyed by a fresh Durable Object id that is never reused, runs the published CLI at a pinned version from the image with the `direct` runtime (no OpenCode in the image, no catalog host to allow), and destroys it when the review ends. The sandbox holds only a per-review job token and reaches only a Worker proxy (`enableInternet: false`). For the GitHub API, the CLI runs with `GITHUB_API_URL` set to the proxy, which exchanges the job token for an installation token minted for that one repository (Metadata read, Contents read, Pull requests write) and allows only reads of that repository and writes to that pull request; the CLI still publishes, so the trust rules of the review conversation (ADR-0016) stay in one place. For git, the clone goes over HTTPS through the egress handler, which adds the same installation token for that repository's URL only. For models, the gateway accepts the job token as the linked account.
4. **Untrusted git.** Shallow fetch of the pull request's base and head only, no submodules, no LFS smudge, hooks off (`core.hooksPath=/dev/null`), `protocol.file.allow=never`, a disk quota, a non-root user. ocra's pull request mode already reads configuration, rules and memory from the base commit and never runs repository code.
5. **Cost limits.** Containers bill wall time while a review waits on models, so a review has a hard 30-minute limit, the account has a global `max_instances`, and a kill switch (a flag in D1 the consumer reads) stops new reviews at once. Start at 1 vCPU and 3 GiB, measure, then size: about $0.01 to $0.02 per review after the plan's included usage. Workers Paid ($5 a month) is required; the first month's spend ceiling is $20 beyond it.
6. **Fallback: Google Cloud Run Jobs.** The image is a plain OCI image and the starter is the only Cloudflare-specific code, behind one small interface, so moving is a week, not a rewrite.

## Note (2026-10-04): GitHub Actions is not an option for other people's repositories

A $0 starter that runs reviews in a private ocra-owned repository's GitHub Actions was considered and rejected: GitHub's Additional Product Terms forbid using GitHub-hosted runners for activity unrelated to the software project of the repository they run in, as part of a serverless application, or as a service offered for commercial purposes, and the penalty (suspension of the account that also carries the open repository, npm trusted publishing and the sign-in App) is not worth the saving. The compliant options are this record's Containers, Cloud Run Jobs' free tier (about 190 reviews a month, a billing account), or the customer's own CI. The maintainer deferred hosted reviews on 2026-10-04: the GitHub Action in the user's own CI stays the way to review pull requests.

## Consequences

- Phase 2 needs Workers Paid: the maintainer approves the $5 before it ships.
- Containers' new scheduling is public beta and its older classes are supported only to 2026-12-31: pin the SDK and reassess on that date.
- An installation must be linked to an ocra Cloud account that holds a provider key; until it is, the App posts one comment saying how, and reviews nothing.
- First slice: a private App installed only on the maintainer's own repositories, so the first fork pull requests to Open-CR-Agent are the live test ADR-0013 still lacks; the installation is linked to the account by hand. Deferred: self-service linking, check runs (the summary comment is the status), cancelling a review in flight, organization settings, usage views, the Cloud Run starter.
- Reviews in the customer's own Actions stays possible later as a "bring your own compute" option for teams that want no code to leave their CI; it is not the default.

## Alternatives considered

- **Fly Machines:** the cheapest per review, but no outbound allowlist, and a second platform.
- **Cloud Run Jobs:** the fallback; mature, a free tier of about 190 reviews a month, but a second cloud account, IAM and slower starts.
- **The customer's GitHub Actions:** no compute for us, but setup friction defeats the App's purpose.
- **Lambda:** the 15-minute limit cuts long reviews.

Reviewed with Claude Fable 5.1: accepted with conditions on fork gating and the payer, proxy-scoped credentials with the CLI still publishing, bounded retries, and wall-time cost limits, written into the Decision. Proposed: deferred by the maintainer on 2026-10-04 (see the note above).
