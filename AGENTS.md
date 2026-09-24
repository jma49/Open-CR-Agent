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

## Code style

- **The code is the documentation.** Avoid large comment blocks. Express intent through names, types and small functions. Write a comment only for a "why" the code cannot say: a non-obvious constraint, a workaround, a deliberate trade-off. Never restate what the code does, narrate a change, or leave TODO chatter.
- Source files, identifiers and commit messages are in English.
- Prefer pure functions for deterministic stages; keep I/O at the edges.
- Validate every LLM output against a Zod schema before it crosses a stage boundary.

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
- Record significant technical decisions as a new ADR in `docs/adr/` instead of rewriting old ones.
