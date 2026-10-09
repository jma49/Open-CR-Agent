---
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
---

### Added

- `ocra review --resume <run-id>` reuses the completed tasks of an earlier run whose inputs are unchanged and runs only the rest; `ReviewOptions.resume` does the same for embedders, and `tasks[].reusedFrom` in the JSON report names the run that paid for a reused task.
