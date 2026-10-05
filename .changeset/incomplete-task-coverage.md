---
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
"@open-cr-agent/vcs-platform": minor
"@open-cr-agent/runtime-direct": minor
"@open-cr-agent/runtime-opencode": minor
---

### Changed

- A review task whose reviewer ran out of steps, or stopped, before it called the done tool no longer counts its files as reviewed: they are `incomplete` (partly reviewed) in coverage, the run exits `3`, the message says what to do, and the pull or merge request summary lists them ([#477](https://github.com/jma49/Open-CR-Agent/issues/477)).

### Added

- The JSON report's `tasks[].ended` (`step_cap` or `stopped_early`) and coverage status `incomplete` with `ended`; `coverageGaps()` counts them in `incomplete`, and `isUnfinished()` tells which coverage entries the next review includes; a runtime marks an attempt whose last turn used every step with `AttemptOutcome.atStepCap`.
