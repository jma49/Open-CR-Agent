# ADR-0060: Team context for golden cases

- Status: accepted
- Date: 2026-11-22

## Context

ADR-0057 measures every review context source on the golden set, and its per-source ablation is to decide which sources stay. Learnings (ADR-0037), project documents and linked tasks (ADR-0052) never appeared in that measurement: the cases run with `--no-repo-config` on repositories that hold no `.ocra/learnings`, name no `projectDocs` and link no tasks. Their budgets come from synthetic inputs, and an ablation of them would compare two identical prompts.

## Decision

1. **A golden case may carry `context`**: `projectDocs` (paths in the repository at `base`) and `learnings` (at most 10, each a learning file's frontmatter with a `name` and a `body`, validated with the contract's `learningFrontmatterSchema`; a test reads each one with the CLI's own parser).
2. **Learnings go through the shipped path.** A review reads them only from its trusted base, so the eval commits them onto `base` and replays every commit of `base..head` on the new tree, with the same authors, dates and messages and with signatures dropped (`packages/eval/src/team-context.ts`). The diff and the commit subjects a range review shows stay the same; no ref, working tree or index changes; the same case gives the same commits on every run. A range that already holds `.ocra/learnings` is refused.
3. **Project documents go through `--config`**: a copy of the run's configuration with the case's `projectDocs`, written in the clone's `.git/ocra-eval/`.
4. **Learnings restate earlier fixes, never the expected issue.** Each comes from a fix commit that is an ancestor of `base` (`source.kind` `fix-commit`, `ref` the commit, `created` its date), what the team knew before the change. Some are about other code than the change, and a clean case carries them too, so a run shows a learning's cost where it cannot help.
5. **Linked tasks stay synthetic.** A local range review has no way to receive them: they come from the platform or from a tracker the change request names a key for. A golden case gets them when a local input exists; this decision adds none.

## Consequences

- `ocra-eval run` and `ocra-eval context` give every case its context; `--without learnings` and `--without project_docs` (ADR-0057) now remove something real.
- Three ocra cases carry context: `ocra-override-trust` and `ocra-judge-downgrade` (expected issues) and `ocra-serve-state-clean` (clean), each with `docs/architecture.md` and `docs/adr` and two or three learnings. Measured with `ocra-eval context` (no model calls): learnings reach 75 of their 96 tasks (18.8k tokens, mean 250 per task), project documents 23 (8.2k, mean 356); every other source is unchanged, token for token.
- ocra's own history is public, so these cases are never held out; held-out cases can carry context the same way.
