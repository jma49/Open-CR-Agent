# ADR-0023: The OpenCode runtime is an optional dependency of the CLI, loaded on use

- Status: accepted
- Date: 2026-10-03

## Context

`@open-cr-agent/cli` depended on both runtimes. `runtime-opencode` brings `opencode-ai` and, through its optional platform packages, a native OpenCode binary of about 140 MB, plus the MCP SDK and its HTTP server stack: of the 108 packages the Action installed, 97 were there only for OpenCode (175 MB on disk against 11 MB). Since ADR-0020 a review on declared endpoints can run with `"runtime": "direct"`, which needs none of it, yet every `npm install` and every Action run downloaded it.

The default runtime stays `opencode`, so `npm install -g @open-cr-agent/cli && ocra review` must keep working with no further step. The options:

- **Peer dependencies, optional (`peerDependenciesMeta`).** The user installs the runtime they want. Breaks the default: a plain install would have no runtime.
- **`runtime-direct` a dependency, `runtime-opencode` installed on demand.** The same break for the default runtime, which is the one most users run.
- **Both dependencies, imported lazily.** Faster start-up for direct users, but the same download: it does not address the cost.
- **`runtime-opencode` an optional dependency, imported lazily.** npm installs optional dependencies by default, so the default install is unchanged; `npm install --omit=optional` and `npm ci --omit=optional` leave it out (not `npm install -g`, below). The CLI's optional dependencies were already OpenCode's platform binaries and nothing else, and `--omit=optional` already made the OpenCode runtime unusable on npm 12 (no binary), so the flag gains a clean meaning: no OpenCode.

## Decision

1. **`@open-cr-agent/runtime-opencode` moves to the CLI's `optionalDependencies`;** `runtime-direct` (a few kB, no dependencies of its own) stays a dependency. The tests pin the result: in the Action's pinned lockfile, `runtime-opencode`, `opencode-ai` and `@opencode-ai/sdk` are optional and every other `@open-cr-agent` package is required.
2. **The CLI imports the configured runtime when a review needs it** (`packages/cli/src/commands/review/runtimes.ts`), with a dynamic `import()` of the built-in runtime of that name; a name it does not know is left to the configuration's plugins, as before. `--plan` imports no runtime. When the package is not installed, the review stops before any model call with exit code 2, naming the package, the exact version to install next to ocra, and `"runtime": "direct"` as the alternative. Only a missing runtime package is translated; any other load failure surfaces unchanged.
3. **The GitHub Action gets an `opencode` input,** `true` by default. `false` installs the pinned lockfile with `--omit=optional`: 11 packages, 11 MB, 0.8 s for `npm ci` on a cold cache on the maintainer's machine, against 108 packages, 175 MB and 6.4 s. The input is explicit rather than read from `.ocra/config.json`: the install runs before ocra resolves which configuration is trusted (the base commit's on pull requests), and a second reader of that file would be a second place to get that wrong. A configuration that needs OpenCode under `opencode: false` fails with the error above.
4. **No `actions/cache` for the Action's install.** The install deliberately uses a fresh npm cache of its own so that packages, registry metadata, signatures and attestations come from the registry on every run; a restored cache is writable by any workflow of the caller's repository on that branch, and the provenance check compares against what `npm view` answers. The cold install took 7 to 10 s on Linux and macOS runners and 35 s on Windows (CI, 2026-10-02, with OpenCode); `opencode: false` removes most of the download, which is what a cache would have saved, without a new trust boundary.
5. **The container image keeps OpenCode:** it runs the default runtime.

## Consequences

- Default installs, the Action's default and the image behave as before. A project install with `--omit=optional` and the Action's `opencode: false` give a direct-runtime install without OpenCode.
- **`npm install -g` ignores `--omit=optional`** (npm 11.19 and 12.2, checked on 2026-10-03 with ocra's tarballs and with a registry package): a global install always brings OpenCode. The manual's lean install is therefore a project install into a directory of its own (`npm install --prefix <dir> --omit=optional @open-cr-agent/cli`, then `<dir>/node_modules/.bin/ocra`). Revisit if npm starts honoring the flag for global installs.
- `npm run check:packages` installs the packed tarballs the Action's way with `--omit=optional` and checks that OpenCode is absent, `review --plan` runs and `review` exits 2 with the message.
- A user who installed with `--omit=optional` and later wants OpenCode installs `@open-cr-agent/runtime-opencode` at the CLI's exact version next to it (Node resolves it from the enclosing `node_modules`, global installs included), or reinstalls without the flag.
- Embedders of `@open-cr-agent/core` are unaffected; the published package of `runtime-opencode` is unchanged.
- If OpenCode stops shipping as optional platform packages, or the CLI gains another optional dependency, the meaning of `--omit=optional` must be checked again; the pinned-lockfile test fails when a required ocra package becomes optional.
