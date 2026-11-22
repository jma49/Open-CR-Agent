---
"@open-cr-agent/core": minor
"@open-cr-agent/vcs-platform": minor
"@open-cr-agent/vcs-github": minor
"@open-cr-agent/vcs-gitlab": minor
"@open-cr-agent/cli": minor
---

### Added

- Reviewers of a pull or merge request see the issues it closes, or the issue its branch is named after: at most 3, cut to fixed sizes, from the reviewed repository only. The report's `linkedTasks` lists them; `linkedTasks: false` or `--no-linked-tasks` turns it off.
- `VcsAdapter.linkedTasks()` and the `LinkedTask` record for adapters that can link tasks.

### Changed

- Workflows written by `ocra init` and the manual's recipes grant `issues: read`.
