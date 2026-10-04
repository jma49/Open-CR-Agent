---
"@open-cr-agent/cli": patch
---

### Changed

- `ocra memory add` says why a session's report cannot be read instead of finding nothing in it.
- The OpenCode runtime validates the session messages it reads; an answer in another shape fails the task with the reason instead of being read in part.
