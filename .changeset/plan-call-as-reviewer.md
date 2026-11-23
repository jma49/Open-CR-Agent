---
"@open-cr-agent/core": minor
"@open-cr-agent/runtime-direct": patch
---

### Changed

- A task's plan call is asked as its reviewer and shares the start of the task's prompt, so on Anthropic's protocol the task reads its files from the prompt cache instead of storing them again. `CompletionRequest.sharedPrefixes` is new.
