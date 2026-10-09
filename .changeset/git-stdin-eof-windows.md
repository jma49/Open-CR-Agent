---
"@open-cr-agent/vcs-local": patch
---

### Fixed

- On Windows, a git command that exits before reading all of its input no longer fails the local review with `write EOF`. Its exit code decides the outcome, as on Linux and macOS.
