# ADR-0065: Reviewers that take the change as a whole

- Status: accepted
- Date: 2026-11-23

## Context

The review matrix (ADR-0007) starts one task per bundle and reviewer. Bundles exist so that a reviewer reads related code together: an interface with its implementation, a function with its callers. That serves the correctness, security and performance reviewers.

The docs and agents-md reviewers do something else. They compare what the change does with documents outside it (the README, the manual, `AGENTS.md`), and where the changed files sit relative to each other tells them nothing. Run per bundle, they repeat the same instructions, guidelines and file list once for every bundle, and they are the tasks a large change loses first: on a 42-file change the task limit of 60 cut 27 tasks, all of them these two reviewers', and the files they would have covered were reported as not reviewed.

Measured with `ocra-eval perf` (ADR-0061) on two real changes:

| Change | Tasks | Model requests | Note |
|---|---|---|---|
| 27 files, before | 56 (docs 12, agents-md 12) | 275 | |
| 27 files, after | 38 (docs 3, agents-md 3) | 201 | |
| 42 files, before | 60 of 87 | 303 | 27 tasks cut by the task limit, exit 3 |
| 42 files, after | 59 (docs 4, agents-md 4) | 309 | nothing cut, every file reviewed |

## Decision

1. **A reviewer's scope says what it spans.** `ReviewerScope.span` is `"bundle"` (the default) or `"change"`. Tier, guidelines, the off switch and ignored files apply as before, bundle by bundle, so what is skipped and why reads the same.
2. **A reviewer that spans the change gets its files in as few tasks as their size allows:** at most 20 files and the bundle size limit (120,000 characters of diff) a task. Files keep the run order of their bundles, sensitive paths first (ADR-0049). A change of one bundle keeps that bundle's label; otherwise the task is labelled `whole change`, numbered when there are several.
3. **These tasks run after the per-bundle ones,** so a spend limit that ends a run early has spent itself on correctness, security and performance first.
4. **The docs and agents-md reviewers span the change.** Their prompts are unchanged.

## Consequences

- A change of many bundles costs about a third fewer review tasks and model requests, and reaches the task limit later; what the limit cuts is no longer two whole reviewers.
- A whole-change task of five files or more gets a plan call, like any bundle of that size (on the light tier here).
- One task now covers up to 20 files within the same step cap. Whether these reviewers find as much is what the golden smoke comparison linked in the pull request answers.
- Plugins can set `span` on their own reviewers.
