---
"@open-cr-agent/core": minor
---

### Added

- A review agent that ends without `task_done` (at the step cap, or after stopping early) gets one more turn, with only `report_finding` and `task_done`, to report what it has already confirmed; the report's task records it as `wrapUp`, next to its `ended`, and its files still count as partly reviewed (`incomplete`), since the turn reads nothing more ([#469](https://github.com/jma49/Open-CR-Agent/issues/469)).
- Runtime SPI: `ModelAttempts.task` may return a `TaskAttempt` whose `wrapUp()` continues the attempt's conversation; `WRAP_UP_MESSAGE`, `WRAP_UP_TOOLS` and `WRAP_UP_STEPS` describe the turn.
