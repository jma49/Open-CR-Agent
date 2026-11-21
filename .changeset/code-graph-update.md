---
"@open-cr-agent/code-graph": minor
---

### Added

- `updateGraph` builds the symbols of every file of a revision from a tree listing, parsing only files the previous graph lacks; `graphReferences` answers a review's callers from it, and `serializeGraph` / `parseGraph` store it in a versioned, deterministic format.
