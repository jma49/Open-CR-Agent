---
"@open-cr-agent/cli": patch
---

### Fixed

- Upgrading fixes concurrent ocra runs on one machine signing each other out of ocra Cloud: one process refreshes at a time under a lock beside `credentials.json`, always with the refresh token it re-reads inside the lock, and a refresh refused because another process rotated the token takes that process's saved pair instead of signing out.
