---
"@open-cr-agent/cli": minor
"@open-cr-agent/core": minor
"@open-cr-agent/vcs-platform": minor
---

### Added

- A round of `ocra mend --level commit` leaves one comment on the pull or merge request with its commit: what it fixed, what it left and why, and the `git revert` that undoes it.
- `VcsAdapter.note` and `RoundNote` in `@open-cr-agent/core`.
