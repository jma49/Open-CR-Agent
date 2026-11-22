---
"@open-cr-agent/cloud-contract": minor
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
---

### Added

- `mergeChecks` in configuration: pre-merge checks in plain words, each judged against the change with a reason, in the summary comment and the report's `mergeChecks`.
- `ReviewOptions.mergeChecks` for embedders.
- A pull or merge request review's upload carries each check's outcome (its reason when the account shares findings) and the ids of the learnings its tasks were given.
- The contract exports `mergeCheckSchema`, `sharedMergeCheckSchema` and `LEARNING_PROPOSAL_BRANCH`.
