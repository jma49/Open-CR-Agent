---
"@open-cr-agent/runtime-direct": patch
---

### Changed

- On an Anthropic Messages endpoint, a single-request call (a plan phase, Verify, Judge, grouping) no longer stores its prompt in the provider's prompt cache. Nothing read it back, and storing costs a quarter more than sending.
