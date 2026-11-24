---
"@open-cr-agent/core": minor
"@open-cr-agent/vcs-platform": minor
"@open-cr-agent/cli": minor
---

### Added

- When a coding agent ran the review, ocra names it after itself, as `ocra · Codex`, in the summary comment's heading, under each inline comment and at the start of the check's title. The `codex` runtime names Codex. A runtime names its agent with the new `AgentRuntime.agent`, and `ReviewReport.agent` carries it.
