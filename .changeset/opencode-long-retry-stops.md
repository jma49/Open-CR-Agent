---
"@open-cr-agent/core": minor
"@open-cr-agent/runtime-opencode": patch
---

### Fixed

- On the `opencode` runtime a task no longer waits out a long retry OpenCode holds a session in, such as a daily limit's wait until midnight: the session is stopped within seconds and the refusal counts as a quota limit, so the run moves on or stops as it does on `direct`.

### Added

- `MAX_QUOTA_WAIT_MS` in `@open-cr-agent/core`: the longest rate limit wait a run sits out, for runtime plugins that see a provider's stated wait.
