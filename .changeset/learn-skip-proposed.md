---
"@open-cr-agent/cli": minor
"@open-cr-agent/vcs-local": patch
---

### Changed

- `ocra learn` skips what a learning on origin's `ocra/learnings-*` proposal branches records, so a proposal waiting for review, or one closed without merging, is not drafted again; `--propose` names its files apart from theirs, so two proposals never conflict.
