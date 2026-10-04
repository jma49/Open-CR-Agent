---
"@open-cr-agent/core": minor
---

### Changed

- `ReviewOptions` groups its settings: `limits` (`concurrency`, `taskTimeoutMs`, `runTimeoutMs`, `maxCostUsd`, `maxTasks`), `stages` (`verify`, `judge`), `mode` (`full`, was `fullReview`; `ultra`) and `identity` (`runId`, `provenance`).
- `ReviewOptions.selection` takes any of its fields; the rest keep their defaults.
