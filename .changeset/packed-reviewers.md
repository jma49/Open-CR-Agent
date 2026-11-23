---
"@open-cr-agent/core": minor
---

### Added

- `ReviewerScope.span: "packed"`: the reviewer takes bundles that follow each other in run order in one task, up to the bundle size limits.

### Changed

- The security and performance reviewers pack neighbouring bundles, keeping sensitive paths apart: a change of many small bundles needs about a third fewer review tasks and model requests.
