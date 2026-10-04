---
"@open-cr-agent/core": minor
"@open-cr-agent/runtime-direct": patch
---

### Added

- `ChainRunner` and `ModelAttempts` in `@open-cr-agent/core`: a runtime implements one attempt on one model, and the runner picks the chain, keeps each model's health and fails over, as both built-in runtimes now do; `AttemptOutcome`, `AttemptError` and `QuotaError` describe an attempt.

### Changed

- The direct runtime words a tier without a model as the OpenCode runtime does: `No model configured for the "<tier>" tier; set models.<tier> in .ocra/config.json or OCRA_MODEL_<TIER>`.
