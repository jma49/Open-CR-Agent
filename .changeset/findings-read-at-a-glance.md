---
"@open-cr-agent/core": patch
"@open-cr-agent/vcs-platform": patch
---

### Changed

- An inline comment on GitHub and GitLab opens with the finding's title on a line of its own, with its severity, reviewer and verification under it, names its fix **Suggested fix**, and folds the facts the reviewer checked under **Evidence**. A finding listed in the summary puts its title first and its text on the next line.
- The built-in reviewers word a finding to be read in a diff: a title of at most 12 words, a body of at most three sentences that opens with what goes wrong, code in backticks.
