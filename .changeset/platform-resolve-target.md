---
"@open-cr-agent/vcs-platform": minor
"@open-cr-agent/vcs-github": minor
"@open-cr-agent/vcs-gitlab": minor
"@open-cr-agent/cli": patch
---

### Added

- `resolveGitHubTarget` and `resolveGitLabTarget` find a pull or merge request the way `ocra review --pr` and `--mr` do, with their token, API address and origin rules, and make its adapter; `vcs-platform` exports the types they share (`ResolveTargetOptions`, `PlatformTarget`, `ChangeRequestRef`, `LocalCode`).

### Removed

- The `@open-cr-agent/vcs-github/internal` and `@open-cr-agent/vcs-gitlab/internal` entries, which only the CLI used and were not a contract.
