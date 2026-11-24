---
"@open-cr-agent/cli": minor
"@open-cr-agent/core": minor
"@open-cr-agent/cloud-contract": minor
"@open-cr-agent/vcs-platform": minor
"@open-cr-agent/vcs-github": minor
"@open-cr-agent/vcs-gitlab": minor
---

### Added

- `ocra mend --checks` also works on the checks that failed on the head of a pull or merge request and do not fail on its base branch: at most 3 a round, each as a fixer task given the last 200 lines of the failed job's log as data. Nothing from the repository runs. `--findings` may be left out with it.
- `ocra mend` answers the outcome `waiting` when the head's checks are still running and nothing else is open; an item of its result names its `check`.
- `VcsAdapter.checks`, `ChangeChecks` and `FailedCheck` in `@open-cr-agent/core`, read by the GitHub and GitLab adapters; `ReviewPlatform.checks` and `failingOnBase` in `@open-cr-agent/vcs-platform`.
