---
"@open-cr-agent/cli": patch
---

### Fixed

- `ocra serve` writes its address and token file in one rename, so a client that finds the file never reads it empty or half written.
