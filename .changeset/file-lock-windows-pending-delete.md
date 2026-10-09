---
"@open-cr-agent/cli": patch
---

### Fixed

- On Windows, a process that finds the ocra Cloud credentials' lock still being removed now waits for it. It used to carry on without the lock, so two runs could refresh the session at once.
