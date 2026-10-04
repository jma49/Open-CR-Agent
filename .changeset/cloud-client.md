---
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
---

### Added

- Error code `CLOUD_API_FAILED`: `ocra login` and `ocra whoami` name it when ocra Cloud cannot be reached or answers something unusable.

### Changed

- Every call to ocra Cloud sends the `ocra/<version>` user agent and waits up to 30 seconds; each answer is checked before it is used, and one that does not fit is treated like a refusal.
