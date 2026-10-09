---
"@open-cr-agent/vcs-local": patch
---

### Fixed

- A working tree review lists each directory once per run instead of once per file read, which cost about 0.4 s per read in a directory of 100,000 entries.
- A working tree review reads a file under a directory whose name is stored decomposed on disk (as on macOS) by the precomposed name git reports.
