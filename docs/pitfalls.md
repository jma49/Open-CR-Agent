# Pitfalls

Traps we have already fallen into, across this repository and the site. Each entry says what happened, why, and what to do instead. Add an entry whenever something costs more than a few minutes to understand; remove it when the cause is gone for good (for example, a pinned dependency is upgraded and the behavior changed).

## OpenCode runtime

- **OpenCode injects your environment into prompts.** With default settings the system prompt carried every skill installed under the user's home (~10k characters) and the reviewed repository's `AGENTS.md`. Always start it through `serverEnv()` in `packages/runtime-opencode/src/server-env.ts`, which sets the `OPENCODE_DISABLE_*` flags and points `XDG_*_HOME` and `OPENCODE_CONFIG_DIR` at a per-run temporary directory.
- **An empty agent prompt is not empty.** OpenCode falls back to its 27k-character coding prompt, and the per-call `system` field is *appended* to the agent prompt. Keep the one-line agent prompt and pass reviewer prompts per call.
- **Untitled sessions cost an extra model call** to generate a title. Always create sessions with a title.
- **The server is open by default.** Without `OPENCODE_SERVER_PASSWORD` it is unauthenticated, and `--port=0` silently becomes 4096. Pick a free port and a random password per run (`opencode-server.ts`).
- **Plugins in the `plugin` config key are not loaded** (1.18.32). They load only from `plugins/` directories; the project one would write into the reviewed repository. Deliver tools over MCP instead (ADR-0005).
- **The Google provider reads only `GOOGLE_GENERATIVE_AI_API_KEY`.** `GEMINI_API_KEY` and `GOOGLE_API_KEY` must be mapped when starting the server.
- **npm blocks the postinstall that places the OpenCode binary.** Resolve the platform package (`opencode-<os>-<arch>[-baseline][-musl]`) directly (`binary.ts`); `OCRA_OPENCODE_BIN` overrides.
- **Upgrading OpenCode can add tools.** Built-in tools are disabled by an explicit list; a test fails when the pinned version's list changes. Never bump `opencode-ai` or `@opencode-ai/sdk` without re-running that test and re-reading the new tools.

- **Node's fetch ends a request after 300 s without data, and the OpenCode SDK's `timeout = false` does not stop it.** That setting only works on Bun. OpenCode answers a prompt only when the agent is done, so a long review failed with `UND_ERR_BODY_TIMEOUT`, which is not an abort: the session kept running and spending, the task got no failover, and its cost was lost. The runtime now passes the SDK a fetch built on undici's own `fetch` and an `Agent` with both timeouts off (#109). Use undici's `fetch` with undici's `Agent`: mixing its `Agent` with Node's bundled fetch breaks across versions.

## Models and providers

- **A missing provider key looks like a missing model.** Without its key OpenCode does not load the provider and answers `ProviderModelNotFoundError: Model not found: google/…` (surfaced to us as `UnknownError`). Check the key first; OpenCode's own log (`--print-logs`) shows the real error.

- **`gemini-3.8-flash` fails inside OpenCode's step loop** with 400 "Requests ending with a model turn are not supported", even without overload, so it is not in any example or dogfood chain. Treat every model error except credential errors as retryable on the next model.
- **An agent's last allowed step ends with a model turn.** OpenCode appends an assistant message on the last step, and Gemini answers 400 "Requests ending with a model turn are not supported". With `steps: 1` every helper call (grouping, Verify, Judge) failed on Gemini, so those stages silently failed safe (#66). The helper now gets two steps; never configure an agent with one. Review tasks on `gemini-3.6-flash` and `gemini-3.7-flash` hit the same 400 after 10–11 tool calls on a 24-line change (2026-09-27, #171); whether that is the 20-step cap is not yet known.
- **Provider overload (503) is the normal case, not an edge case.** OpenCode retries ~4 times internally and then fails the turn; a failback chain is required.
- **Unbounded agent loops are the biggest cost risk.** Each step resends the whole conversation; one run spent 127k input tokens over 271 s. Agent steps are capped at 20; keep a cap on anything that loops over a model.
- **Quota exhaustion looks like overload.** Check the error body before assuming a 503 is transient.
- **The free-tier `gemini-3.5-flash` limit is 20 requests a day, and the error's "retry in N s" is not to be trusted.** Every agent step is one request: one pull request used about 19, a probe an hour later got the 20th, and a run later still was refused from its first request. Google still says "Please retry in ~50s" on this daily limit (`generate_content_free_tier_requests, limit: 20`), which once misled us into calling it a rate limit. ocra honors a stated wait up to three times and then takes the model out of the run (`quota.ts`), so a spent daily quota costs about 2.5 minutes of waiting per ocra process, not a stream of refused requests. Quality evaluation needs a paid key. The dollar figures ocra reports are list prices computed from tokens, not what a free-tier key is billed.
- **Vertex ignores `VERTEX_LOCATION` under ocra.** OpenCode 1.18.32's `google-vertex` provider reads `GOOGLE_VERTEX_LOCATION`, then `GOOGLE_CLOUD_LOCATION`, then `VERTEX_LOCATION`, and falls back to `us-central1`; `serverEnv()` forwards only the first two, so a location set as `VERTEX_LOCATION` is dropped without an error. The Gemini 3.x models in our chains answered on `global` (2026-09-27); set `GOOGLE_VERTEX_LOCATION=global`. The project comes from `GOOGLE_VERTEX_PROJECT` or `GOOGLE_CLOUD_PROJECT`, credentials from application-default credentials under `HOME`.
- **`gemini-flash-lite-latest` rejects OpenCode's requests on Vertex** with 400 "Thinking_config.include_thoughts is only enabled when thinking is enabled": the model has thinking off there, and OpenCode asks for thoughts. Every helper call on it fails (grouping failed on 2026-09-27). `gemini-3.5-flash-lite` and `gemini-3.1-flash-lite` accept the request; use one of them for the light tier on Vertex.
- **One Vertex run can report no cached tokens while the next caches most of the prompt.** A one-task probe reported 0 cached; the 14-task run right after reported 2.21M cached against 657k uncached. Judge caching from a whole run, not one task.
- **Reasoning tokens can exceed output tokens.** Always report them separately, and budget for them.

## Git and diffs

- **A path check on the requested name is not a check on the file read.** The access policy refused `.env` by name, but workspace reads followed symlinks, so a committed `notes.txt -> .env` returned the secret (#104). Working-tree reads now behave like `git cat-file`: a link reads as its target path, and a path through a linked directory does not exist. Anything that writes into the reviewed tree (session logs) must refuse links too.
- **ocra's own output is an untracked change.** The session log was created before the diff was read, so workspace reviews reviewed `.ocra/sessions/**/events.jsonl`. The sessions directory now carries a `.gitignore` with `*`; anything else ocra writes into a repository needs the same. The first fix (`07052b6`) changed the docs and the test but not the code, and the test still passed: `git status --porcelain` collapses a new untracked directory to `.ocra/`, so asserting it does not contain `.ocra/sessions` proves nothing. Use `--untracked-files=all` when a test asserts a file is ignored.

- **git may close stdin before we finish writing.** Writing input to a git process that already exited raises `EPIPE`; ignore `EPIPE` and trust the exit code (`vcs-local/src/git.ts`).
- **User git configuration changes diff output.** `diff.noprefix`, `diff.mnemonicPrefix`, `diff.relative`, external diff drivers and textconv all break parsing. Always pass the explicit flags in `DIFF_ARGS` (`--src-prefix=a/ --dst-prefix=b/ --no-ext-diff --no-textconv --no-relative -c core.quotepath=true`).
- **A copied index must keep its timestamp.** Git catches same-second, same-size edits by comparing entry timestamps with the index file's own ("racy git"). Copying the index to a temporary file gave it a fresh timestamp, so git trusted stale stat data and a real edit was missing from the review. Copy with `preserveTimestamps`; the regression test pins mtimes and disables `core.trustctime` to reproduce it deterministically.
- **User-supplied refs can be options.** A ref such as `--output=x` is parsed as a flag; pass `--end-of-options` before any user ref.
- **The repository root is not the working directory.** Paths from git are root-relative; resolve against `git rev-parse --show-toplevel`.
- **"Inside the repository" is not "safe to read".** Path containment (including symlinks) does not stop an agent from reading `.env` or `.git/config`; see the 2026-09-26 audit, finding S1.

## Evaluation (AACR-Bench)

- **Some dataset commits no longer exist** (force-pushed away). Try `git fetch origin <sha>`, then `pull/<n>/head`, then mark the PR unavailable instead of failed.
- **The official judge parser counts "No, they are not the same" as a match** because it contains "same". Our parser treats an answer that opens with "no" as no; keep that difference documented when comparing numbers.
- **Blobless clones fetch blobs one at a time on demand.** Check out the head commit once so code search at that commit does not trigger thousands of fetches.
- **Some benchmark repositories use Git LFS.** Checkout ran the LFS smudge filter and failed (`smudge filter lfs failed`), so the PR counted as a review failure. Reviews only need the pointer files. `GIT_LFS_SKIP_SMUDGE=1` is not enough when a config declares the filter but git-lfs is not installed, and `filter.lfs.required=false` alone is not enough on git 2.43 (Ubuntu 24.04), where a process filter that cannot start is still fatal; newer git passes, so CI stayed green. `GIT_ENV` in `packages/eval/src/repos.ts` also blanks `filter.lfs.process` and sets `filter.lfs.smudge` to `cat`, all through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` so no config file is touched.
- **A resumed run reuses failures.** Use `--retry-failed` after fixing the cause, or the old failure stays in the numbers.
- **Benchmark repositories are untrusted code.** `ocra-eval` runs the CLI inside them; anything the CLI loads from the reviewed repository (plugins, config) runs with your keys.

## Tooling and workflow

- **Scripted multi-file edits can silently do nothing.** Biome reformatting changed the target text twice, so string replacements matched nothing and the script reported success. Assert that each target string exists before replacing, or use exact edits.
- **Judge lint by exit code, not by the last line of output** (`npm run lint; echo $?`).
- **Biome checked git-ignored files** (build output, sessions) until `vcs.useIgnoreFile` was enabled.
- **The MCP SDK's types are not written for `exactOptionalPropertyTypes`.** The transport is cast once, with a comment, in `tool-server.ts`; do not loosen the compiler option.
- **A shell keeps the environment it started with.** A key exported in a profile afterwards is invisible to an already running shell or agent session; start a new one or load just that variable.

- **`gh pr checks --watch` returns at once when CI has not registered yet.** A merge right after pushing can skip CI. Wait until checks exist, then watch, then merge only if every check passed.
- **A failed `cd` makes the rest of a command run in the wrong place.** A chain like `cd worktree && npm ci; npm run verify` rebuilt `dist/` in the main checkout. Use absolute paths, `&&` all the way, or stop on the first error.
- **Rebuilding while an eval runs changes the code under evaluation.** `ocra-eval` spawns the built CLI per PR, so `tsc -b` mid-run mixes versions. Build in a separate worktree, or wait.
- **Killing ocra without a signal handler orphans `opencode serve`.** Fixed by Ctrl-C/SIGTERM handling; `kill -9` still orphans it.
- **Test fakes that report findings for every task break when a reviewer's tier changes.** Several CLI tests assumed only `correctness` ran on their small fixtures; letting `security` run at every tier (#85) doubled their findings. Fakes report from the reviewer the test is about (`spec.reviewer`).
- **Source files include tests for the 500-line rule.** Split test files before they grow past it: shared fakes go in a `*.fakes.ts` file next to them, which each package's `tsconfig.json` excludes from the build and `tsconfig.test.json` includes.
- **Workspace packages resolve to `dist/`.** CLI tests import `@open-cr-agent/core` through its build output, so after changing core they see the old code until `tsc -b` runs (`npm run verify` does); a failing CLI test right after a core edit may just be stale output.
- **Gate commits on the verify exit code.** A compound command that ignores it pushes failing code; CI catches it, but the history does not need it.

- **A line-based `sed` edit hits every matching line.** Adding an import with `sed 's/^  correctnessReviewerPlugin,$/…/'` also inserted the function `coverageGaps` into `BUILTIN_PLUGINS`, which type-checked (a function has a `name`) and did nothing (#123). Edit by exact multi-line match, and pin lists like `BUILTIN_PLUGINS` in a test.

## Site

- **Inline SVGs must not use `id` references.** The layout renders the logo more than once, and duplicate ids make gradients and masks resolve to the wrong element.
- **The manual is generated.** `content/docs` in the site is copied from `docs/manual` here; edits there are overwritten. Edit the manual in this repository.
- **Check the site on a local production build** (`npm run build && npx next start`) rather than deploying to look at it; see `docs/pending-verification.md`.
- **Vercel's Hobby build limit.** When every merge that touched `docs/manual/` triggered a site build, a day with many manual changes hit "Deployment rate limited — retry in 24 hours". That is why Git deployments are off and the site is deployed by hand (`npm run deploy` in the site repository).
- **Deploy hooks do not run while Git deployments are off.** With `git.deploymentEnabled: false` in `vercel.json`, triggering the project's deploy hook returned success but created no deployment (`vercel ls` showed nothing new); the docs only mention the deprecated `github.enabled` as blocking hooks. Deploy through the Vercel CLI instead.
- **CJK headings do not balance well automatically.** Give Chinese headings their own sizes and explicit line breaks.
