---
"@open-cr-agent/core": minor
"@open-cr-agent/vcs-platform": minor
"@open-cr-agent/vcs-github": minor
"@open-cr-agent/vcs-gitlab": minor
"@open-cr-agent/cli": minor
---

### Added

- A finding may carry a `fix` (`{ startLine, endLine, replacement }`), in the JSON report and as SARIF `fixes`; no reviewer produces one yet ([ADR-0029](https://github.com/jma49/Open-CR-Agent/blob/main/docs/adr/0029-committable-suggestions.md)).
- An inline comment on exactly a fix's lines ends with a committable suggestion: GitHub's `suggestion` block, GitLab's `suggestion:-N+0`, posted as written or not at all.

### Changed

- `ReviewPlatform` (`@open-cr-agent/vcs-platform`) requires `suggestionFence`, the platform's suggestion syntax.
