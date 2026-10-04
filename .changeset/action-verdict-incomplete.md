---
"@open-cr-agent/cli": patch
---

### Fixed

- The Action's `verdict` output is empty unless the review completed (exit code 0 or 1); a run that reviewed nothing used to output `approved`.
