---
"@open-cr-agent/cloud-contract": minor
"@open-cr-agent/cli": minor
---

### Added

- The review upload's `outcomes` can carry `fixedFingerprints` and `dismissedFingerprints`, at most 200 each; a signed-in review sends them when the account shares findings, so ocra Cloud can mark which earlier findings a re-review saw fixed or dismissed.
