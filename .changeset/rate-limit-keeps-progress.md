---
"@open-cr-agent/core": minor
"@open-cr-agent/runtime-direct": minor
---

### Changed

- Eight review tasks run at once by default instead of four (`concurrency`): a review of more than four tasks takes up to 42% less time where the provider's rate limit allows it (measured on changes of 26 and 49 tasks), with the same tasks and prompts; a small change of four tasks or fewer takes as long as before. Set `concurrency` to 4 for the old pace.
- On the `direct` runtime a rate limit no longer costs a task its progress: the refused request waits for the model's pause and is sent again, where the task used to start over and ask for every step a second time.

### Added

- `RateLimits`, handed to `ModelAttempts.task`: a runtime plugin's attempt can wait a rate limit out with `waitOut(quota)` and send its request again.
