---
"@open-cr-agent/cli": patch
---

### Fixed

- Concurrent ocra processes no longer break each other's ocra Cloud session: one refreshes at a time under a lock beside `credentials.json`, and a refresh refused because another process rotated the token takes that process's saved pair instead of signing out.
