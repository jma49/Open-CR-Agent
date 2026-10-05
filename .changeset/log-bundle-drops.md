---
"@open-cr-agent/core": patch
---

### Added

- The session log (`events.jsonl`) records each finding dropped because it names a file outside its task's bundle, as a `finding_dropped` event with the file and title.
