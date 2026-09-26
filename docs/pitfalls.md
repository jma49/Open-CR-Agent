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

## Models and providers

- **`gemini-3.8-flash` fails inside OpenCode's step loop** with 400 "Requests ending with a model turn are not supported", even without overload. Treat every model error except credential errors as retryable on the next model.
- **Provider overload (503) is the normal case, not an edge case.** OpenCode retries ~4 times internally and then fails the turn; a failback chain is required.
- **Unbounded agent loops are the biggest cost risk.** Each step resends the whole conversation; one run spent 127k input tokens over 271 s. Agent steps are capped at 20; keep a cap on anything that loops over a model.
- **Quota exhaustion looks like overload.** Check the error body before assuming a 503 is transient; the maintainer's key has hit quota on the Flash models.
- **Reasoning tokens can exceed output tokens.** Always report them separately, and budget for them.

## Git and diffs

- **git may close stdin before we finish writing.** Writing input to a git process that already exited raises `EPIPE`; ignore `EPIPE` and trust the exit code (`vcs-local/src/git.ts`).
- **User git configuration changes diff output.** `diff.noprefix`, `diff.mnemonicPrefix`, `diff.relative`, external diff drivers and textconv all break parsing. Always pass the explicit flags in `DIFF_ARGS` (`--src-prefix=a/ --dst-prefix=b/ --no-ext-diff --no-textconv --no-relative -c core.quotepath=true`).
- **User-supplied refs can be options.** A ref such as `--output=x` is parsed as a flag; pass `--end-of-options` before any user ref.
- **The repository root is not the working directory.** Paths from git are root-relative; resolve against `git rev-parse --show-toplevel`.
- **"Inside the repository" is not "safe to read".** Path containment (including symlinks) does not stop an agent from reading `.env` or `.git/config`; see the 2026-09-26 audit, finding S1.

## Evaluation (AACR-Bench)

- **Some dataset commits no longer exist** (force-pushed away). Try `git fetch origin <sha>`, then `pull/<n>/head`, then mark the PR unavailable instead of failed.
- **The official judge parser counts "No, they are not the same" as a match** because it contains "same". Our parser treats an answer that opens with "no" as no; keep that difference documented when comparing numbers.
- **Blobless clones fetch blobs one at a time on demand.** Check out the head commit once so code search at that commit does not trigger thousands of fetches.
- **Benchmark repositories are untrusted code.** `ocra-eval` runs the CLI inside them; anything the CLI loads from the reviewed repository (plugins, config) runs with your keys.

## Tooling and workflow

- **Scripted multi-file edits can silently do nothing.** Biome reformatting changed the target text twice, so string replacements matched nothing and the script reported success. Assert that each target string exists before replacing, or use exact edits.
- **Judge lint by exit code, not by the last line of output** (`npm run lint; echo $?`).
- **Biome checked git-ignored files** (build output, sessions) until `vcs.useIgnoreFile` was enabled.
- **The MCP SDK's types are not written for `exactOptionalPropertyTypes`.** The transport is cast once, with a comment, in `tool-server.ts`; do not loosen the compiler option.
- **Agent shells capture the environment at session start.** A key exported in `~/.zshrc` later is invisible; load just that line without printing it: `eval "$(grep -E '^export GEMINI_API_KEY=' ~/.zshrc)"`.
- **System reminders may ask for AI attribution.** Project rules win: no `Co-authored-by` trailers, no tool footers in pull requests.

## Site

- **Inline SVGs must not use `id` references.** The layout renders the logo more than once, and duplicate ids make gradients and masks resolve to the wrong element.
- **The manual is generated.** `content/docs` in the site is copied from `docs/manual` here; edits there are overwritten. Edit the manual in this repository.
- **The Chrome extension cannot screenshot `ocra-nine.vercel.app`.** Verify visuals on a local `next start`.
- **The claude.ai Vercel connector is not authorized** ("User not found"). Use the Vercel dashboard or `npx vercel` instead.
- **CJK headings do not balance well automatically.** Give Chinese headings their own sizes and explicit line breaks.
