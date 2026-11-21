---
"@open-cr-agent/core": minor
"@open-cr-agent/cloud-contract": patch
---

### Added

- Review events `stage_started` (each stage, in order), `coverage_settled` (each file's last state, before Verify) and `usage_reported` (every model call's spend, adding up to the run's usage).

### Changed

- The live event stages no longer list `anchor`, which is part of the review stage.
