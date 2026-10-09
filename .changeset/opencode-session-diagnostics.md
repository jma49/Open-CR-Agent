---
"@open-cr-agent/core": patch
"@open-cr-agent/runtime-opencode": patch
---

### Added

- `AppliedSettings.unsentBecause`: why a runtime sent no reasoning effort when the cause is not the capability table. `AttemptOutcome.unreadMessages`: how many of a session's messages a runtime could not read.

### Fixed

- On the `opencode` runtime, when OpenCode's model catalog cannot be read at start, the effort warning now gives that cause instead of saying the capability table knows no way to send the level.
- On the `opencode` runtime, one session message in an unexpected shape no longer drops the attempt's findings and usage: it is skipped and counted in the attempt's progress line.
