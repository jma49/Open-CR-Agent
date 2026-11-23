---
"@open-cr-agent/runtime-direct": patch
---

### Fixed

- A finding refused for its arguments in the same answer as `task_done` is no longer lost: the task goes on, so the reviewer reads the refusal and can report it again.
