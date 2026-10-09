---
"@open-cr-agent/cli": patch
---

### Fixed

- Concurrent ocra processes no longer renew the ocra Cloud session with the same refresh token: a process waits out another's renewal (up to two and a half minutes, saying so after five seconds) instead of giving up after 10 seconds, the lock of a process that died is broken (at once when its process has exited) by one process only, a renewal never saves over a session saved meanwhile, and `ocra login` and `ocra logout` wait for a renewal in progress. Two renewals with one token could leave a superseded token saved and end the session at its next use.
