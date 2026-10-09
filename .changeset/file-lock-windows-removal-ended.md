---
"@open-cr-agent/cli": patch
---

### Fixed

- On Windows, a process that tried to take the ocra Cloud credentials' lock just as another process's lock was being removed could carry on without it, so two runs could refresh the session at once. It now takes the lock.
