# ADR-0007: Review matrix

- Status: accepted
- Date: 2026-09-26

## Context

M2 adds reviewers beyond correctness. Running every reviewer on every bundle makes cost grow as bundles × reviewers, spends security and performance reviewers on documentation, and ignores the risk tier that triage already computes.

## Decision

A deterministic planner (`planMatrix`, `packages/core/src/pipeline/matrix.ts`) runs between Bundle and Execute and turns bundles × reviewers into cells:

- Each `ReviewerDefinition` may declare a `scope`: `minTier` (lowest change risk tier it runs at) and `ignore` (globs of files it never sees).
- A cell is skipped as `disabled`, `below_tier` or `no_matching_files`; otherwise the bundle is narrowed to the reviewer's files.
- Configuration overrides the reviewer's own scope: `reviewers.<id>.enabled` and `reviewers.<id>.minTier` in `.ocra/config.json`.
- The report lists skipped cells (`skipped`) and marks files no cell covers as `unreviewed`, so a cheaper plan never hides a coverage gap.

Paths that force reviewers onto a bundle (for example, security on `auth/`) are not a separate rule: sensitive paths already raise the tier to `full`.

## Consequences

- Cost follows risk: trivial changes get only reviewers without a `minTier`.
- Reviewers stay plugins; the matrix reads only their declared scope.
- Adding a rule type (for example, reviewers by language) means extending `ReviewerScope`, not the pipeline.
