---
"@open-cr-agent/core": minor
"@open-cr-agent/runtime-direct": patch
---

### Changed

- Every reviewer is sent one system prompt, and its own instructions after the files, in `<ocra_reviewer_brief>`: on an endpoint with a prompt cache, the reviewers of a change read the start and the files one of them stored instead of each storing them. A plugin reviewer's `systemPrompt` is sent as that brief. The prompts fingerprint in a report's provenance changes.
