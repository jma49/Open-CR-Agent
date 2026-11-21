---
"@open-cr-agent/vcs-local": patch
---

### Changed

- Files at a revision are read through one long-lived `git cat-file --batch-command` (git 2.36 or later) instead of a process per file.
