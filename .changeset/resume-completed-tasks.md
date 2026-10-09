---
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
---

### Added

- `ocra review --resume <run-id>` reuses the completed tasks of an earlier run whose inputs are unchanged and runs only the rest; `ReviewOptions.resume` does the same for embedders, and `tasks[].reusedFrom` in the JSON report names the run that paid for a reused task.
- Review events: `task_reported` (a completed task's findings and the key of its inputs) and `groups` on `files_bundled` (each bundle's files). An exhaustive `switch` over `ReviewEvent` needs the new case.
