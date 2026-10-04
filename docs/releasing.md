# Releasing

How the packages reach npm. Eight packages are published: `@open-cr-agent/core`, `runtime-opencode`, `runtime-direct`, `vcs-local`, `vcs-platform`, `vcs-github`, `vcs-gitlab` and `cli` (the `ocra` command). `@open-cr-agent/eval` is private. All of them share one version and depend on each other at exactly that version, so a published `cli` never pairs with a `core` from another release.

Releases go out through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): publishing a GitHub release starts `.github/workflows/release.yml`, which publishes with a short-lived OIDC token, and npm attaches [provenance](https://docs.npmjs.com/generating-provenance-statements). No npm token is stored anywhere. npm can trust a workflow only for a package that already exists, so the first version is published once by hand.

Decided on 2026-09-26 and 2026-09-28: the scope is `@open-cr-agent` (npm organization `open-cr-agent`, owned by the maintainer's account `majincheng_ocra`), releases are `0.x` with the early status stated in the README, and publishing is trusted publishing rather than a stored token.

## Tools

- **`node scripts/release.mjs version <x.y.z>`** sets the version on every workspace package and on the dependencies between them, and updates `package-lock.json`. (`npm version --workspaces` leaves those dependencies behind.)
- **`node scripts/release.mjs publish`** is a dry run. It checks that the packages share one version, that the checkout is clean and its commit is on `origin/main`, that `CHANGELOG.md` has a section for the version and that npm is logged in; it asks the registry which versions are missing, runs `npm run verify` and `npm run check:packages`, packs those packages and runs `npm publish --dry-run` on each. It ends with "Dry run finished: --publish would publish N package(s)", or lists what `--publish` would refuse and fails.
- **`node scripts/release.mjs publish --publish`** does the same and publishes, dependencies first, stopping at the first failure. Versions already on the registry are skipped, so running it again resumes where it stopped.
- **`node scripts/release.mjs notes <x.y.z>`** prints that version's section of `CHANGELOG.md`, the body of the GitHub release.
- **`npm run check:packages`**, also the `packages` job of every pull request, packs every package, installs the tarballs into an empty project as a user would, and runs the installed `ocra`. Then it installs them as the GitHub Action does (below), from the tarballs, and runs that `ocra` too.
- **The GitHub Action** (`action.yml`) runs `scripts/action-install.mjs`. It installs the published `@open-cr-agent/cli` at the version in its own `packages/cli/package.json`, into a directory of its own, with a lockfile built from the `package-lock.json` at the Action's ref (`scripts/pinned-lock.mjs`): every third-party package at the version CI tested there, with its integrity hash. Install scripts stay off, npm uses a cache of its own under `$RUNNER_TEMP`, and on the npm registry `npm audit signatures` checks the registry's signatures (and provenance, from 0.1.1). `npm audit signatures` passes a package that has no provenance, so `scripts/provenance.mjs` then requires each of ocra's own packages to have SLSA provenance naming this repository, `.github/workflows/release.yml` and the tag `v<version>`, for the tarball npm serves. It builds the ref from source instead when that version is not on npm (between a version bump and its publish), when npm has it with other dependencies than the ref declares or without that provenance (0.1.0, published by hand), or when the pinned install fails. So a release tag runs what was published, with the dependencies it was tested with, and `@main` runs the latest release named on `main`, not unreleased code. The `action` job of every pull request runs both paths, with no model call, and fails when the Action built from source for any reason but a package not on npm yet or changed dependencies (the install step's `source` output).
- **`.github/workflows/release.yml`** runs on a published GitHub release, or by hand as a dry run (`gh workflow run release.yml --ref main`; its `dry-run` input defaults to true). Its `pack` job installs the repository without install scripts, runs `npm run verify` and packs the tarballs, with no right to publish. Its `check` job then runs `scripts/check-packages.mjs --tarballs` on those exact tarballs: it installs them as a user would, with third-party install scripts on, which is why it runs apart from the job that packs. Its `publish` job, which waits for both, the only one that can mint a publish token, installs nothing and runs only npm and `scripts/release.mjs`, which has no dependencies. It publishes only tarballs whose sha512 matches what `pack` reported as a job output: the artifact passes through the run where `check` runs third-party code, which could replace it, and a job's outputs cannot be replaced. It publishes only from a tag that matches the version, `v<x.y.z>`, and a prerelease (`0.2.0-rc.1`) goes to the `next` dist-tag instead of `latest`.

## The first release

Done: the organization `open-cr-agent` exists, and the owner account has two-factor authentication for authorization and writes, with a security key (Touch ID).

1. In a checkout of the repository, on an up-to-date `main` with nothing uncommitted:

   ```bash
   git switch main && git pull
   npm ci
   npm whoami        # majincheng_ocra
   ```

2. Dry run. It must end with "Dry run finished: --publish would publish 5 package(s)."

   ```bash
   node scripts/release.mjs publish
   ```

3. Publish:

   ```bash
   node scripts/release.mjs publish --publish
   ```

   The checks take a minute or two. Then, for the first package, npm prints a link (Enter opens it) where you confirm with the security key; tick the option there to skip two-factor authentication for the next five minutes, and the other four publish without asking again (without it, each package asks once). If a package fails, fix the cause and run the same command again.

4. Trust the release workflow for each package. `npm trust` needs npm 11.15 or newer and asks for the security key the same way:

   ```bash
   for p in core runtime-opencode vcs-local vcs-github cli; do
     npm trust github "@open-cr-agent/$p" --file release.yml --repo jma49/Open-CR-Agent --allow-publish --yes
     sleep 2
   done
   npm trust list @open-cr-agent/cli
   ```

   The file name and the repository are matched exactly, case included.

5. On npmjs.com, for each package: **Settings → Publishing access → Require two-factor authentication and disallow tokens.** Trusted publishing keeps working; a token, even a leaked one, can no longer publish.

6. Create the GitHub release on the commit that was published (the publish command prints this line with the commit filled in):

   ```bash
   node scripts/release.mjs notes 0.1.0 | gh release create v0.1.0 --target "$(git rev-parse HEAD)" --title v0.1.0 --notes-file -
   ```

   The release workflow runs; it finds every package on the registry, skips them all, and passes.

7. Merge the pull request that switches the README and the manual's installation pages to npm (#234, a draft until then: mark it ready first), then deploy the site so the manual and the quality page are live.

8. Try it as a user, outside the repository: `npm install -g @open-cr-agent/cli`, `ocra --version`, and `npx @open-cr-agent/cli --version`.

## Later releases

1. On a branch: `node scripts/release.mjs version <x.y.z>`, and a `## <x.y.z>` section at the top of `CHANGELOG.md`. Open a pull request and merge it.
2. Optionally, a dry run in CI: `gh workflow run release.yml --ref main`, then `gh run watch`.
3. Release from the merged commit on `main`:

   ```bash
   node scripts/release.mjs notes <x.y.z> | gh release create v<x.y.z> --target <commit> --title v<x.y.z> --notes-file -
   ```

   The workflow checks that the tag matches the version and that the commit is on `main`, runs the checks, and publishes with provenance. Until it has published, the Action at the new tag builds from source: it finds the version missing on npm.
4. Check the release as a user, in a scratch project outside the repository: `npm install @open-cr-agent/cli@<x.y.z>`, `npx --no-install ocra --version`, and `npm audit signatures --json --include-attestations`. Its `verified` list must name each of ocra's packages (third-party packages with provenance appear there too): the provenance that ties each one to this repository's workflow and tagged commit.
5. Move the Action examples to the new tag (README, `docs/manual/*/github.mdx`, the site's landing page), with the manual's pinned-commit example if it names one.

### The container image

After `publish`, the release workflow's `image` job waits until npm serves the new version, then builds `Dockerfile` with `OCRA_INSTALL=npm` for amd64 and arm64: `scripts/action-install.mjs` installs the published packages, and the build fails if that script would build from source instead. It pushes `ghcr.io/jma49/ocra:<version>` (and `latest` for a release that is not a prerelease) with an SBOM and build provenance, attested with `actions/attest-build-provenance`. The first push creates the package as private: make it public once, under the package's settings on GitHub. Every pull request's `image` job builds the Dockerfile from the commit itself (`OCRA_INSTALL=source`) and runs `ocra --version` and a `--plan` review in it.

### Adding a package

npm lets a workflow publish with trusted publishing only to a package that already exists. So before the first release that includes a new package (as `vcs-platform` and `vcs-gitlab` were before 0.2.0), publish that one package by hand, at the version `main` has before the release's version bump, then trust the workflow for it:

```bash
git switch main && git pull && npm ci && npm run build
cd packages/<name> && npm publish --access public && cd ../..
npm trust github "@open-cr-agent/<name>" --file release.yml --repo jma49/Open-CR-Agent --allow-publish --yes
```

That version has no provenance and no release uses it; the release workflow then publishes the new version, with provenance, like every other package. On npmjs.com, set **Require two-factor authentication and disallow tokens** for the new package too. Until this is done, a release that includes the package fails in the `publish` job, at that package.

### When a publish fails halfway

- Re-run the failed jobs (`gh run rerun <run-id> --failed`); the packages already published are skipped. Locally, run the same `publish --publish` again. The registry can take a minute to list a version it just accepted; a re-run in that window tries it again, and npm refuses (`E403`, cannot publish over a published version). Wait a minute and run it once more.
- If the fix needs a code change and nothing was published (the `pack` or `check` job failed), fix it on `main`, delete the release and its tag (`gh release delete v<x.y.z> --cleanup-tag`), and release again.
- If some packages were published, do not move the tag: release the next patch version. Users are not affected in between: `cli` is published last, and each `cli` depends on exactly its own version of the others.
- A version number can never be published twice, even after an unpublish, and npm allows unpublishing only [under conditions](https://docs.npmjs.com/policies/unpublish). To withdraw a broken release, deprecate it (`npm deprecate "@open-cr-agent/cli@<x.y.z>" "<reason>"`) and release a fix.

## Caveats

- **Optional dependencies.** `@open-cr-agent/runtime-opencode` is an optional dependency of the CLI (ADR-0023), and the OpenCode binary an optional platform package of `opencode-ai` below it, where ocra looks for it. A project install with `--omit=optional` (and the Action's `opencode: false`) leaves OpenCode out entirely: `ocra review` with the `opencode` runtime then stops with exit code 2 and names the package; `npm install -g` ignores the flag and always installs it. `npm run check:packages` checks the lean install. When `runtime-opencode` is installed but its platform package is not, ocra uses the binary `opencode-ai`'s install script places, or stops with "No OpenCode binary … set OCRA_OPENCODE_BIN". (Where npm runs `opencode-ai`'s install script, it copies the binary into `opencode-ai/bin/`, downloading it when the platform package is missing; ocra looks there after the platform packages, and takes the file only when it is a native executable, not the placeholder script the package ships.) Default installs work whether or not npm runs install scripts: npm 11.16 and later warn about `opencode-ai`'s, npm 12 blocks it by default (checked with npm 11.19 and 12.1 on 2026-09-29). Like that script, ocra picks the musl build on musl Linux and the baseline build on x64 without AVX2.
- **Node versions.** The packages need Node.js 22.19 or newer (`engines`), the minimum of undici 8, which the OpenCode runtime uses. The release workflow runs on Node 24 because trusted publishing needs npm 11.5.1 or newer and Node 22 ships npm 10.
- **A user-level `allow-scripts` npm setting** used to break `npm run check:packages` (`EALLOWSCRIPTS`, see `docs/pitfalls.md`); the check now removes it for its nested install.

## Renaming the repository

GitHub redirects git, web and API calls after a rename, but **GitHub Actions does not**: `uses:` of an action or a reusable workflow under the old name fails with "repository not found" (tried on 2026-10-01; the dogfood run resolved zero jobs). Everything below names the repository, so a rename is done with a release, all on one day, in this order:

1. Rename the repository on GitHub.
2. In the release pull request, with the version bump: `repository.url` and `bugs` in every `packages/*/package.json` (the Action compares `repository.url` with the published provenance, so changing it before the version is on npm makes CI's `action (npm)` jobs build from source and fail); the `uses:` paths in `.github/workflows/ocra-review.yml` and `ocra-dogfood.yml` and the test that pins them (`scripts/dogfood-workflow.test.mjs`); `uses: jma49/<repo>@…` in the manual (both languages) and the README; `--repo` in this file and in the `gh attestation verify` lines of the manual; clone URLs; the Dockerfile's `org.opencontainers.image.source` label; the issue templates; a "needs action" entry in the changelog for everyone's `uses:` lines.
3. Trust the release workflow again for every package, with `--repo jma49/<repo>` (step 4 of the first release), before publishing.
4. In Google Cloud, the Workload Identity provider's attribute condition names the four repositories: replace the old name (`.local/dogfood-setup.sh` holds the condition).
5. In jmos, Assay and vouch, the dogfood caller's `uses:` line.
6. The site: the quickstart's `uses:` line, the links, the manual sync script's default repository; then deploy.
7. The Claude GitHub App's repository access, and the agent session's repository scope.

## Follow-ups

- `npm install -g @open-cr-agent/cli` resolves third-party ranges when it runs, unlike the Action. An `npm-shrinkwrap.json` in the cli package would pin them, but npm installs a dependency's shrinkwrap without platform checks: every OpenCode binary for every OS and CPU, 2.1 GB instead of 175 MB (`docs/pitfalls.md`). Worth another look if npm starts checking platforms there, or if the OpenCode binary stops coming as optional platform packages.
- A GitHub environment with required reviewers would add an approval before each publish. To use one, add `environment: <name>` to the `publish` job and pass `--env <name>` to `npm trust`; not needed while one maintainer releases.
