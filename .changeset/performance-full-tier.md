---
"@open-cr-agent/core": minor
---

### Changed

- The performance reviewer runs at the `lite` risk tier only on bundles with a file on a hot path (a path word such as cache, query, queue, pool, stream or cluster), and otherwise only at `full` (was every `lite` and `full` change). `reviewers.performance.minTier: "lite"` brings it back everywhere (ADR-0082).

### Added

- `ReviewerScope.focus`: path words on which a reviewer runs from a lower tier than its `minTier`.
