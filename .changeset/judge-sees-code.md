---
"@open-cr-agent/core": patch
---

### Changed

- The judge sees each finding's quoted code and its verification, so it merges duplicates by the lines they quote and never drops a confirmed finding as speculative.
