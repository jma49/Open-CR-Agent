---
"@open-cr-agent/core": minor
---

### Added

- What a runtime needs besides `ChainRunner` is public in `@open-cr-agent/core`: `reviewTools`, `REVIEW_TOOLS`, `MAX_AGENT_STEPS`, `RESUME_MESSAGE`, `parseModel`, `parseQuotaError`, `withoutSecrets`, `emptyUsage`, `addUsage`, `EFFORT_LEVELS`, `thinkingBudget` and `proxiedFetch`. The built-in runtimes import nothing from `@open-cr-agent/core/internal`.
