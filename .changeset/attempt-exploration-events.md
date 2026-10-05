---
"@open-cr-agent/core": patch
"@open-cr-agent/runtime-direct": patch
"@open-cr-agent/runtime-opencode": patch
---

### Added

- The session log (`events.jsonl`) records, on each attempt's summary line, the files the reviewer read, what it searched for and its final text (`attempt`), so a missed issue can be traced to a file it never opened or one it read and passed over; the report is unchanged. Runtimes report them through `exploredBy()`.
