---
"@open-cr-agent/cli": minor
---

### Added

- The Action's `learn` input (`mine` or `remember`) drafts learnings and opens them as a pull request, with a `proposal` output; with the workflow's own token the pull request is left for a person to merge.
- `ocra learn --propose --require-review` leaves the pull or merge request for a person whatever `learnings.requireReview` says.
