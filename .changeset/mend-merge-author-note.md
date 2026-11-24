---
"@open-cr-agent/core": patch
"@open-cr-agent/vcs-platform": patch
"@open-cr-agent/vcs-github": patch
---

### Fixed

- `ocra mend --conflicts` authors its merge commit on GitHub with the bot's `<id>+<login>` noreply address, so GitHub links it to the account, also on GitHub Enterprise Server.
- The comment after a merge round says it merged the base branch and gives `git revert -m 1` to undo it.
