---
"@open-cr-agent/cli": patch
"@open-cr-agent/vcs-github": patch
"@open-cr-agent/vcs-gitlab": patch
"@open-cr-agent/vcs-platform": patch
---

### Fixed

- The first Ctrl-C of a pull or merge request review no longer waits out a GitHub or GitLab rate-limit pause before stopping.
