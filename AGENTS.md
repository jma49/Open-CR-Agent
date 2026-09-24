# AGENTS.md

Rules for humans and AI agents working on Open-CR-Agent (`ocra`). This file is a living document: add a rule here whenever a review surfaces a convention worth keeping.

## Project

Open-CR-Agent is an open-source multi-agent code review system. Deterministic engineering (file selection, bundling, rule matching, anchoring) wraps LLM agents that only make judgment calls. See [docs/architecture.md](docs/architecture.md) and the decision records in [docs/adr/](docs/adr/).

- Language: TypeScript (ESM, strict), Node >= 22
- Monorepo: npm workspaces under `packages/`
- Tests: Vitest (`npm test`) · Types: `npm run typecheck` · Lint/format: Biome (`npm run check`)

| Package | Responsibility |
|---|---|
| `@open-cr-agent/core` | Domain types, pipeline stages, `VcsAdapter` / `AgentRuntime` / plugin contracts |
| `@open-cr-agent/runtime-opencode` | `AgentRuntime` backed by the OpenCode SDK |
| `@open-cr-agent/vcs-github` | `VcsAdapter` for GitHub pull requests |
| `@open-cr-agent/cli` | The `ocra` command |
| `@open-cr-agent/eval` | Benchmark replay (AACR-Bench) and quality metrics |

`core` depends on nothing inside the repo. Adapters depend only on `core`. Only `cli` wires concrete adapters together.

## Code style

- **The code is the documentation.** Avoid large comment blocks. Express intent through names, types and small functions. Write a comment only for a "why" the code cannot say: a non-obvious constraint, a workaround, a deliberate trade-off. Never restate what the code does, narrate a change, or leave TODO chatter.
- Source files, identifiers and commit messages are in English.
- Prefer pure functions for deterministic stages; keep I/O at the edges.
- Validate every LLM output against a Zod schema before it crosses a stage boundary.

## Git workflow

- `main` is always releasable. Never commit to it directly.
- Every feature or significant iteration gets its own branch, named `<type>/<short-kebab-description>` (for example `feat/select-stage`, `fix/anchor-crlf`).
- Open a pull request to merge into `main`. Delete the branch once the PR is merged (the repository deletes merged branches automatically).
- Keep PRs small and focused on one increment; split work that grows beyond a reviewable size.

## Commit messages

- Follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<optional scope>): <subject>`.
  - Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Subject: imperative mood, lowercase start, no trailing period, at most 72 characters.
- Body (optional): wrap at 72 characters, explain *what* and *why*, not *how*.
- One logical change per commit.
- **Commits must not include `Co-authored-by` trailers or any other co-author metadata.**

## Agile practices

- Work is planned as milestones (M1–M4 in the architecture doc) broken into small issues, each deliverable in one PR.
- Every PR keeps `npm run typecheck`, `npm test` and `npm run check` green; CI enforces it.
- New behavior ships with tests. Review-quality changes (prompts, rules, stages) must be measured with the eval package before merge.
- Record significant technical decisions as a new ADR in `docs/adr/` instead of rewriting old ones.
