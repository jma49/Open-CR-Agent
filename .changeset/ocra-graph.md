---
"@open-cr-agent/cli": minor
"@open-cr-agent/vcs-local": minor
---

### Added

- `ocra graph --out <file> [--rev <commit>]` writes the code graph of a commit, and updates an existing one by parsing only the files it lacks.
- `ocra review --graph <file>` takes the callers of changed symbols from that graph, after `--scip` and before searching.
