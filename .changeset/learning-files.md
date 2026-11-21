---
"@open-cr-agent/cli": minor
---

### Added

- `ocra review` reads the team's learnings from `.ocra/learnings/*.md` at the trusted revision (the base commit for `--pr` and `--mr`) and gives each task those that apply; a file that is not a valid learning is skipped with a warning (ADR-0037).
