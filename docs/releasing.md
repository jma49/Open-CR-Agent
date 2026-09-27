# Releasing

Nothing has been published yet. This is what is ready, what is missing, and the steps for the first release.

## Ready

- Publishable packages: `@open-cr-agent/core`, `runtime-opencode`, `vcs-local`, `vcs-github` and `cli` (which provides the `ocra` command). `@open-cr-agent/eval` is private.
- Each has repository, homepage, bugs, keywords, `engines` (Node ≥ 22), `files: ["dist"]` and `publishConfig.access: public`.
- `npm run check:packages` packs every package, installs the tarballs into an empty project the way a user would, and checks that the installed `ocra` reports the right version, that `ocra review --plan` works, and that the runtime finds the OpenCode binary. CI runs it on every pull request (job `packages`).
- `ocra --version` reads the CLI's `package.json`.

## Before the first release

- The versioned output format (`version: 1`, `packages/core/src/pipeline/output.ts`) is in place; it becomes a published contract with the first release. The `--plan` JSON is versioned too (`toPlanOutput`).

## Decisions for the maintainer

1. **Scope: decided, `@open-cr-agent`** (2026-09-26). Publishing needs an npm organization named `open-cr-agent`, created by the maintainer before the first release.
2. **When.** Quality is not measured yet (#12, #66). Publishing as `0.x` with that stated in the README is reasonable; waiting for a baseline is safer.
3. **How.** Either an npm automation token stored as a repository secret, or npm trusted publishing (OIDC) from a GitHub workflow, which needs no long-lived token and adds provenance. Trusted publishing is recommended.

## First release, step by step

1. Pick the version (all packages share one), for example `0.1.0`, and set it in every publishable `package.json` and in each internal dependency on `@open-cr-agent/*` (they are exact versions).
2. Update the README install section to `npm install -g @open-cr-agent/cli` and the manual's installation page (both languages).
3. `npm run verify && npm run check:packages`.
4. Publish in dependency order: `core`, then `runtime-opencode`, `vcs-local`, `vcs-github`, then `cli`: `npm publish --workspace packages/<name>` (add `--provenance` from CI).
5. Tag `v<version>` and create a GitHub release.
6. Point `action.yml` at the published CLI instead of building from source, if that proves faster in practice.

## Known install caveat

`opencode-ai`'s postinstall fails when optional dependencies are omitted (`npm install --omit=optional`), because the OpenCode binary comes as an optional platform package. Default installs work.
