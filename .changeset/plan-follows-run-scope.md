---
"@open-cr-agent/core": patch
"@open-cr-agent/cli": patch
---

### Fixed

- `ocra review --plan` with `--pr` or `--mr` plans what the review would cover: only what changed since the previous review when ocra can tell, as the review does, with the scope in the text and in the plan JSON's new optional `scope`; it used to plan a full review the run would not make.
