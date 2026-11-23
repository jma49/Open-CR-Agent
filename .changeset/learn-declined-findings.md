---
"@open-cr-agent/cli": minor
"@open-cr-agent/core": minor
"@open-cr-agent/vcs-platform": minor
---

### Added

- `ocra learn feedback --pr <n>` (or `--mr <iid>`) also drafts learnings from the findings of the pull or merge request's review that someone with write access declined in their thread, with what they said (`ChangeRequest.declined`).
