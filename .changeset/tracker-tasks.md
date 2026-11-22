---
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
"@open-cr-agent/cloud-contract": minor
---

### Added

- `trackers` in configuration: Jira and TAPD tasks a pull or merge request names by key (title, description or branch) are read through the team's MCP server and given to the reviewers with the linked issues.
- `ReviewOptions.taskSources` and `ChangeRequest.branch` for embedders.
