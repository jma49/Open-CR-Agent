---
"@open-cr-agent/code-graph": minor
---

### Added

- The GitHub Action keeps ocra's symbol cache in the Actions cache between runs (`symbol-cache`, on by default) and drops entries no run read for 30 days; reading a cached entry now touches it.
