---
"@open-cr-agent/vcs-github": minor
---

### Added

- On GitHub, an `ocra review` check shows a review running on the pull request's head commit, then its verdict and findings when it ends. It never fails; the workflow needs `checks: write` to show it.
