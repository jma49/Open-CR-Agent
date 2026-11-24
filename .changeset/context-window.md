---
"@open-cr-agent/core": minor
"@open-cr-agent/cloud-contract": minor
"@open-cr-agent/runtime-direct": minor
"@open-cr-agent/vcs-platform": minor
"@open-cr-agent/cli": minor
---

### Added

- `providers.<id>.models.<model>.contextWindow`: the tokens one request to a model may hold, for a self-hosted model with a small window. The plan then holds a task's diff to a quarter of the smallest declared window, and the `direct` runtime ends a conversation before the request that would not fit, with the wrap-up turn, instead of failing on the endpoint's refusal. A prompt that cannot fit is not sent, and the next model of the chain takes the task.
- A task cut short this way ends as `context_window` in the JSON report (`ended`, next to `step_cap` and `stopped_early`) and in the review trace sent to ocra Cloud; the review is incomplete and says why.
- `ReviewLimits.contextWindow`, `ProviderModel` and `AttemptOutcome.atContextWindow` in `@open-cr-agent/core`, for embedders and runtime plugins.
