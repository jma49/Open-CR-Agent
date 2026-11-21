---
"@open-cr-agent/vcs-local": patch
"@open-cr-agent/core": patch
---

### Changed

- Code searches asked in the same turn (the callers of a bundle's symbols, the code around Verify's findings, an agent's parallel tool calls) share one `git grep` of the reviewed revision; a scripted review of 669 files ran in half the time.
