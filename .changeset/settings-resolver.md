---
"@open-cr-agent/cli": patch
---

### Changed

- A shared configuration (`extends`) with an invalid value is ignored, with the usual warning, even when the repository's file sets that key itself; before, the file's value hid the invalid one.
