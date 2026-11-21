---
"@open-cr-agent/cli": minor
"@open-cr-agent/cloud-contract": minor
---

### Added

- A signed-in `--pr` or `--mr` review names the pull or merge request in its upload to ocra Cloud: the repository's address, the number and the head commit.
- `@open-cr-agent/cloud-contract` exports `normaliseRemote` and `REPOSITORY_URL`; the upload schema takes `pullRequest`.
