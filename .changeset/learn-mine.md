---
"@open-cr-agent/cli": minor
---

### Added

- `ocra learn mine` drafts learnings for `.ocra/learnings/` from the fix commits on HEAD's first-parent line: one helper call per fix, kept only when not a duplicate and selected for its own fix, written to the working tree (ADR-0040).
