---
"@open-cr-agent/runtime-direct": patch
---

### Changed

- On an endpoint that speaks Anthropic's Messages protocol, review tasks that start together no longer each pay to store the prompt start they share: the first stores it and the others wait until its answer begins, then read it from the provider's cache.
