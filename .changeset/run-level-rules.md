---
"@open-cr-agent/core": minor
"@open-cr-agent/cli": patch
---

### Added

- `isIncompleteReview(report)` and `isBlocking(report)` in `@open-cr-agent/core`: the rules the CLI's exit codes 3 and 1 apply, for embedders to gate on.

### Fixed

- `ocra metrics` counts a run with a critical finding it could not verify as incomplete, as the run's exit code 3 does; it counted only runs with unfinished files.
