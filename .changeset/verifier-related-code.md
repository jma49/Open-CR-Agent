---
"@open-cr-agent/core": minor
"@open-cr-agent/vcs-platform": minor
---

### Added

- Verify is shown where the names in each finding's quoted code are defined and used elsewhere in the repository, so it can settle claims about callers, types and guards.
- A finding Verify traces to code the change did not bring in is marked `preExisting` in the JSON report and "pre-existing" in review comments; the verdict is unchanged.
