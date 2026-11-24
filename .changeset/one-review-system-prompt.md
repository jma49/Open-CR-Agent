---
"@open-cr-agent/core": minor
"@open-cr-agent/runtime-direct": minor
"@open-cr-agent/cli": minor
---

### Changed

- Every reviewer shares one system prompt, and a reviewer's own instructions follow the bundle's files in `<ocra_reviewer>`, so tasks of different reviewers read the change and its files from the prompt cache instead of each storing them (ADR-0082). A plugin reviewer's `systemPrompt` is sent there too.
- `--plan` and `ocra-eval context` count the reviewer's instructions as their own context source, `reviewer`.
