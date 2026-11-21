---
"@open-cr-agent/cli": minor
"@open-cr-agent/vcs-gitlab": minor
"@open-cr-agent/vcs-platform": minor
---

### Added

- `ocra learn --propose` opens a GitLab merge request that merges when its pipeline succeeds; `--repo` or `--project` names where it opens.
- `proposeOnGitLab` in `@open-cr-agent/vcs-gitlab`, and an optional `sleep` in `ProposeOptions`.
