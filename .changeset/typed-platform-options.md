---
"@open-cr-agent/vcs-platform": minor
"@open-cr-agent/vcs-github": minor
"@open-cr-agent/vcs-gitlab": minor
---

### Added

- `vcs-platform` exports the schemas the platform adapters' options share: `codeSourceSchema`, `historySchema`, `changeRequestSchema`, `commitIdSchema` and `fetchSchema`.

### Changed

- The `snapshot` option of the `github` and `gitlab` adapters is the change request as ocra reads it (validated commit ids), not GitHub's or GitLab's API answer; `resolveGitHubTarget` and `resolveGitLabTarget` build it.
