---
"@open-cr-agent/core": patch
---

### Changed

- Outside `--ultra`, a large bundle gets a plan call only for a reviewer with a task per bundle. The docs, guidelines, security and performance reviewers no longer plan first: those calls were about a tenth of a review's cost and changed no result.
