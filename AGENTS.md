# AGENTS.md

Rules for humans and AI agents working on Open-CR-Agent (`ocra`). This file is a living document: add a rule here whenever a review surfaces a convention worth keeping.

## Project

Open-CR-Agent is an open-source multi-agent code review system. Deterministic engineering (file selection, bundling, rule matching, anchoring) wraps LLM agents that only make judgment calls. See [docs/architecture.md](docs/architecture.md) and the decision records in [docs/adr/](docs/adr/).

- Language: TypeScript (ESM, strict), Node >= 22
- Monorepo: npm workspaces under `packages/`
- Tests: Vitest (`npm test`) · Types: `npm run typecheck` · Lint/format: Biome (`npm run check`) · All three: `npm run verify`

| Package | Responsibility |
|---|---|
| `@open-cr-agent/core` | Domain types, pipeline stages, `VcsAdapter` / `AgentRuntime` / plugin contracts |
| `@open-cr-agent/runtime-opencode` | `AgentRuntime` backed by the OpenCode SDK |
| `@open-cr-agent/vcs-github` | `VcsAdapter` for GitHub pull requests |
| `@open-cr-agent/vcs-local` | `VcsAdapter` for the local git repository (workspace, range, commit) |
| `@open-cr-agent/cli` | The `ocra` command |
| `@open-cr-agent/eval` | Benchmark replay (AACR-Bench) and quality metrics |

`core` depends on nothing inside the repo. Adapters depend only on `core`. Only `cli` wires concrete adapters together.

## Core engineering principles

1. **Architecture and domain first.** Plan toward the ideal architecture: make business goals, domain boundaries, module responsibilities, dependency direction and data flow explicit, and reach a design that fits the domain, is maintainable and can evolve before writing code. Never sacrifice the overall design for short-term convenience. The design must be complete; the implementation must be restrained: no speculative abstractions, introduce an abstraction only when the second real use case appears, implement a single scenario directly.
2. **Elegant modules.** Modules have high cohesion and low coupling and hide internal complexity behind small, stable interfaces, so responsibilities, names, dependencies and extension points read naturally. Split code by single responsibility. **No source file may exceed 500 lines**; refactor module boundaries before a file approaches the limit.
3. **Clear boundaries and data flow.** Protocol models (VCS APIs, LLM I/O), domain models, persistence models and presentation models (CLI output, PR comments) must not leak into each other. Validate and convert data independently at every boundary. Never share mutable state across layers.
4. **Security and isolation by default.** Design every feature for multi-repository, multi-user operation with explicit authentication, authorization and data-isolation boundaries. Apply least privilege (tokens, agent tool permissions). Treat all external input as untrusted, including diffs, PR titles and bodies, repository files and LLM output, and defend against prompt injection. Secrets never appear in code, logs, prompts or responses.
5. **Design for concurrency and failure.** Consider idempotency, race conditions, transaction boundaries, timeouts, cancellation, retries, backpressure and resource cleanup up front. Never mask problems with unbounded retries, swallowed errors or implicitly shared state.
6. **Complete user experience.** Every user-facing surface (CLI output, PR comments, a future session viewer) controls its cost and asynchronous state and covers loading, empty, error, retry, feedback and accessibility states.
7. **Reuse stable domain semantics.** Prefer existing modules and capabilities, but do not abstract early just because code looks alike; when duplication is deliberate, comment why the copies evolve independently or why abstraction is deferred. Before adding a dependency, check whether existing dependencies (root `package.json` and `packages/` workspaces) already cover the need, and read their docs and type definitions before assuming a library lacks a feature. When a new dependency is needed, prefer mature, well-maintained libraries and never re-implement generic functionality.
8. **Preserve context for future maintainers.** Code, comments, tests and architecture docs are how we collaborate across time. Non-obvious design decisions, compatibility constraints, known defects and workarounds must record the reason, scope, risk and removal condition. Link technical debt to a tracked issue, sync key architecture decisions to an ADR, and never leave a `TODO` without context.
9. **Verifiable, observable, reversible changes.** Every change keeps behavior testable, runtime state observable and failures diagnosable, with backward compatibility and a rollback path considered. Errors and logs keep diagnostic context without leaking sensitive data.
10. **Delete rather than keep compatibility.** When refactoring internal paths, delete obsolete implementations directly; do not add compatibility layers, deprecated shims or dual-write logic. Compatibility of external contracts (CLI flags, config file format, plugin interfaces, published package APIs, session file format) is evaluated separately against the contract, as a contractual obligation rather than a reason to keep old code.

> **Change checklist:** run `npm run verify` before every commit (Biome, type check, tests). Prompt, rule or stage changes also need an eval run before merge.

## Engineering best practices

Concrete rules behind the principles above, from the [2026-09-26 self-audit](docs/audits/2026-09-26-self-audit.md). Known traps are collected in [docs/pitfalls.md](docs/pitfalls.md); read it before touching the runtime, git or eval code, and add to it when something bites.

### Security

- **Assume the reviewed code is hostile.** Diffs, commit messages, PR text, `AGENTS.md`, `.ocra/rules.json`, `.ocra/config.json` and every file an agent reads may be written by an attacker. So is LLM output derived from them.
- **Enforce access policy in core, once.** Anything an agent can reach goes through `ReviewContext`; secret paths (`SECRET_PATTERNS`) and `.git/` are refused there, not in each adapter. A new tool or adapter never widens what an agent can read.
- **Never execute repository-supplied code implicitly.** Plugins and configuration from the reviewed tree load only when the user trusts that tree; CI and `ocra-eval` read them from a trusted source or not at all.
- **Neutralize before you embed.** Every untrusted string placed in a prompt goes through `neutralizeTags` / `escapeAttribute`; every untrusted string printed to a terminal has control characters stripped.
- **Least privilege for child processes.** Spawn with `execFile`/`spawn` and argument arrays, never a shell; pass `--end-of-options` before user refs; give child processes only the environment variables they need.
- **Bind local servers to `127.0.0.1` with a per-run random port and credential**, compare credentials with `timingSafeEqual`.
- **Secrets never reach code, logs, prompts, reports or session files.** Tests that touch secret handling assert the secret string is absent from every output.
- **Pin what can change the attack surface.** OpenCode is pinned and its built-in tool list is asserted; treat any bump as a security review.

### Performance and cost

- **Every loop over a model has a cap:** steps per task, tasks per run, and a spend budget. Report tokens (input, cached, output, reasoning) and dollars for every model call, helpers included.
- **Order prompts for caching:** run-wide sections first, bundle-specific sections last.
- **Bound every external input before buffering it:** file counts, file sizes and command output. Exclude early (selection) rather than parse and discard.
- **Do not repeat work within a run.** Content at a fixed revision cannot change; memoize reads per run instead of re-spawning git.
- **Bound concurrency explicitly** (`mapWithConcurrency`); never fan out unbounded `Promise.all` over change-set-sized lists.
- **Measure before optimizing prompts or stages:** an eval run with cost and latency is the benchmark, not intuition.

### Reliability

- **A failure is recorded, not propagated, unless it makes the whole run meaningless.** A failed task, grouping call or listener becomes a warning or a task outcome; the run still produces a report.
- **Every wait has a timeout and honors cancellation;** race runtime events against the abort signal instead of trusting callees to stop.
- **Clean up on every exit path**, including Ctrl-C: dispose runtimes, stop child processes, remove temporary directories.
- **Exit codes are a contract.** Distinguish success, blocking findings, and runs that did not review everything; CI must never read an incomplete review as a pass.

### Testing

- New behavior ships with a test at the lowest layer that can express it; pure stages are tested without I/O, adapters against a real temporary git repository.
- Security properties get explicit negative tests (secret path refused, injected tag neutralized, control characters stripped).
- Tests use fake runtimes; nothing in `npm test` calls a model or the network.

## Code style

- **The code is the documentation.** Avoid large comment blocks. Express intent through names, types and small functions. Write a comment only for a "why" the code cannot say: a non-obvious constraint, a workaround, a deliberate trade-off. Never restate what the code does, narrate a change, or leave TODO chatter.
- Source files, identifiers and commit messages are in English.
- Prefer pure functions for deterministic stages; keep I/O at the edges.
- Validate every LLM output against a Zod schema before it crosses a stage boundary.

## User manual

- The user manual lives in `docs/manual/en/` and `docs/manual/zh/` (MDX, one file per page, navigation in `meta.json`). The project site renders it.
- **Any change to user-facing behavior updates the manual in the same PR, in both languages**: CLI commands, flags, output or exit codes, configuration keys, environment variables, rules, plugin APIs, security properties.
- The manual describes what exists today. Planned features are marked as planned; never document behavior that is not implemented.
- `docs/architecture.md` and `docs/adr/` are for contributors; the manual is for users.
- Merging a manual change to `main` redeploys the site automatically (`.github/workflows/site-deploy.yml`, Vercel deploy hook in the `SITE_DEPLOY_HOOK` secret).

## Git workflow

- `main` is always releasable. Never commit to it directly.
- Every feature or significant iteration gets its own branch, named `<type>/<short-kebab-description>` (for example `feat/select-stage`, `fix/anchor-crlf`).
- Open a pull request to merge into `main`. Delete the branch once the PR is merged (the repository deletes merged branches automatically).
- The author may merge their own PR once CI is green and they have self-reviewed the full diff; the maintainer spot-checks merged PRs afterwards. Link the issue with `Closes #N` so it closes on merge.
- Merge with rebase so each Conventional Commit lands on `main` unchanged.
- Keep PRs small and focused on one increment; split work that grows beyond a reviewable size.

## Commit messages

- Follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<optional scope>): <subject>`.
  - Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Subject: imperative mood, lowercase start, no trailing period, at most 72 characters.
- Body (optional): wrap at 72 characters, explain *what* and *why*, not *how*.
- One logical change per commit.
- **Commits must not include `Co-authored-by` trailers or any other co-author metadata.**
- **Pull request titles, descriptions and comments must not include AI attribution** such as "Generated with Claude Code" or similar tool footers.

## Agile practices

- Work is planned as milestones (M1–M4 in the architecture doc) broken into small issues, each deliverable in one PR.
- Every PR keeps `npm run verify` green; CI enforces it.
- New behavior ships with tests. Review-quality changes (prompts, rules, stages) must be measured with the eval package before merge.
- Record significant technical decisions as a new ADR in `docs/adr/` instead of rewriting old ones. Record spike results in `docs/spikes/`.
- Before ending a working session, update `docs/handoff.md`: current state, environment notes, open questions and next steps. Add anything that cost real time to understand to `docs/pitfalls.md`.
- Periodic self-audits (architecture, engineering including security and performance, product) go in `docs/audits/<date>-<topic>.md`; their actionable findings become issues.
