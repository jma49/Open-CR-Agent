---
"@open-cr-agent/cloud-contract": minor
"@open-cr-agent/cli": minor
---

### Added

- `cloud.shareRepoName` in `.ocra/config.json` (off by default) names the repository in every upload to ocra Cloud, by path and normalised address.
- The review upload takes an optional `repo`: `name` and `url`, validated after normalising.
