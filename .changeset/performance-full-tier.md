---
"@open-cr-agent/core": minor
---

### Changed

- The performance reviewer runs only on changes at the `full` risk tier by default (was `lite` and `full`). `reviewers.performance.minTier: "lite"` brings it back (ADR-0082).
