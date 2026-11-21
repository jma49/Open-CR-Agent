---
"@open-cr-agent/code-graph": minor
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
---

### Added

- `ocra review --scip <file>`: callers of changed symbols come from a SCIP index first, exactly as it resolved them; symbols it does not know are searched for as before.
- `ReviewOptions.references` takes a `ReferenceIndex`; `scipReferences` in `@open-cr-agent/code-graph` reads one from a SCIP file.
