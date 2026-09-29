# Action install audit, 2026-09-29 (0.1.1)

This audits #239 and #240 before the release of 0.1.1:
- #239: the GitHub Action installs the published `@open-cr-agent/cli` instead of building the repository;
- #240: every package at 0.1.1, the changelog and the runbook.

The Action runs in other people's pull request workflows, next to their model keys. The questions were:
- whether what it installs is exactly what was tested and published;
- whether anything the reviewed repository, the job or the registry controls can change that;
- whether the fallback can run less trusted code;
- where it works;
- whether 0.1.1 is ready for its first publish through trusted publishing.

npm ran with an empty user configuration for everything that talks to the registry, and no model was called. Nothing was published.

Severity: **P0** exploitable or wrong in normal use · **P1** real weakness under realistic conditions · **P2** hygiene.

**Verdict: safe to release v0.1.1** from the commit that merges this pull request. There is no P0 or P1 finding. The P2 fixes change the Action's files at the tag, but not the packages.

## Findings

| # | Finding | Confirmed by | Sev | Resolution |
|---|---|---|---|---|
| A1 | **`npm view` and `npm ci` used the runner's `~/.npm` cache.** Cached registry answers and tarballs from an earlier step or a restored `actions/cache` took part in the install. A cached answer that looks fresh is not asked again. | code | P2 | An npm cache of the install's own (`--cache $RUNNER_TEMP/ocra-npm-cache`). CI checks that it exists, which fails without the fix |
| A2 | **The Action's `setup-node` step cached `~/.npm` on its own when the caller's `package.json` names npm as its package manager** (`package-manager-cache` defaults to on since setup-node 5). That saved a cache entry in the caller's repository, which the install never reads. Present since 0.1.0. | setup-node inputs | P2 | `package-manager-cache: false` |
| A3 | **On Windows, npm ran through a shell with its arguments concatenated unquoted.** A path holding a space, such as a self-hosted runner under `C:\Program Files`, split `--prefix` and `--cache`. Node 24 also warns about arguments passed with `shell: true` (DEP0190). | code; Node 26 | P2 | npm gets one command line, with arguments that hold a space quoted |
| A4 | **Only ubuntu x64 ran the install in CI,** although the OpenCode binary is a separate package per platform. | `ci.yml` | P2 | The `action` job runs on ubuntu, macOS and Windows, both ways |
| A5 | **The manual said `@main` runs unreleased changes.** It now runs the release `main` names (#239). | read | P2 | `github.mdx`, en and zh: what the Action installs from v0.1.1, and what `@main` runs |
| A6 | **The 0.1.1 changelog claimed more than holds.** It said signatures are always checked; they are checked only on the npm registry. It said no build tools run with the model key; they still do when the Action builds from source. It said `npm audit signatures` shows the repository, workflow and commit; it verifies them, and the npm page shows them. | read; npm output | P2 | Reworded |
| A7 | **The runbook's post-release check counted attestations.** Third-party packages with provenance count too (11 today), so the count proves nothing about ours. | local run | P2 | Check that the five packages appear in the `verified` list of `npm audit signatures --json --include-attestations` |
| A8 | **The Action does not require provenance for its own packages.** `npm audit signatures` verifies an attestation where one exists, but accepts a version without one. A version published by hand with a stolen login would install. | npm source (`verify-signatures.js`) | P2 | Follow-up in `docs/releasing.md`: require the SLSA provenance's repository, workflow and tag from 0.1.1 on, and build from source without it. Not done here: it needs attestation parsing and fixtures, and the attack needs a publish past security-key two-factor authentication with tokens disallowed |
| A9 | **The job's npm configuration decides where our five packages and their integrity come from.** That covers `npm_config_*` variables, a user configuration written by an earlier step, and a scoped registry for `@open-cr-agent`. `npm audit signatures` checks only packages whose registry publishes keys, so a keyless scoped registry skips them without failing. | npm source | P2 | Accepted. Only the workflow's author, or code already running in the job, can set these, and earlier code in the job can rewrite the Action's own files anyway. The reviewed checkout cannot: see below |
| A10 | **The install step has the caller's model keys in its environment.** Composite steps inherit the `uses:` step's `env`. On the npm path only npm runs, with no package scripts; on the source path `tsc` runs too, as it did before 0.1.1. | code | P2 | Accepted. Filtering npm's environment would need an allowlist that proxies and corporate certificate settings survive |

## Checked and sound

- **The pinned tree.**
  - `scripts/pinned-lock.mjs` walks the dependency graph from the CLI's workspace through the ref's `package-lock.json` the way Node resolves modules.
  - It copies every third-party entry, with its `resolved` URL and integrity, to the same place relative to our packages, and refuses two packages at one place.
  - Our five packages take their integrity and tarball URL from the registry's manifest. The registry signs that integrity, and `npm audit signatures` verifies the signature.
  - `check:packages` runs the same synthesis on every pull request, with local tarballs.
  - The lockfile's OpenCode entries carry `os`, `cpu` and `libc`, so `npm ci` installs only the runner's build.
- **Inputs from the reviewed repository.** Every npm command runs in the Action's own directory or in its install directory, never in the checkout.
  - A run with a hostile `.npmrc` (registry and `@open-cr-agent:registry` pointing elsewhere) and a `packageManager` field in the working directory still installed from registry.npmjs.org.
  - The result was 104 packages with verified registry signatures, and 11 with verified attestations, all third-party (0.1.0 has none).
- **The version.**
  - It is the exact version in the ref's `packages/cli/package.json`, with no dist-tag lookup, and the manifest must report that version.
  - A missing version is `E404` with exit code 1 (npm 11.19), which falls back to the source build.
  - All five packages must declare the same dependencies as the ref.
- **The fallback.** It builds the Action's own ref with that ref's lockfile and `--ignore-scripts`, so it runs no code less trusted than the Action itself.
  - A tampered third-party tarball fails the source build as well.
  - A bad signature fails the job instead of falling back.
- **`npm audit signatures`.** It sets exit code 1 on invalid signatures, and on missing ones from a registry that publishes keys. It throws when nothing could be audited. The script fails the job on either.
- **CI.** The `action` job has `contents: read`, no secrets and `persist-credentials: false`, and its actions are pinned by commit. Fork pull requests run it with nothing to steal.
- **Release readiness.**
  - Every package is at 0.1.1, with exact internal pins.
  - Since 0.1.0 (`c4c0d3c`), the lockfile changed only in workspace versions and no package source changed, so "The CLI and the libraries have not changed since 0.1.0" holds.
  - The release script publishes only from the tag `v<version>`, with the `latest` dist-tag for 0.1.1, and refuses an npm older than 11.5.1 in CI.
  - The publish job has `id-token: write`, Node 24, and `setup-node` with `registry-url` and no token, as in npm's documented example.
  - The workflow's dry run 36540881751 on `e95dac5` succeeded: `pack` passed, `Publish` was skipped and `Dry run` passed (job and step conclusions; the log was not read).

## Not verified

- The OIDC token exchange and the provenance. They happen first when 0.1.1 is published.
- The install on musl and arm64 runners. The Windows and macOS legs of the `action` job run on this pull request.
- A registry that serves one attestation to `npm audit signatures` and another to a reader. This only matters once A8 is built.
