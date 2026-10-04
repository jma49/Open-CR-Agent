---
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
"@open-cr-agent/vcs-platform": minor
---

### Added

- The review state on GitHub and GitLab records the reviewer of each finding, and the JSON report's `rereview` entries carry it as `reviewer`; `PriorFinding.reviewer` is optional, so state written before still loads.

### Fixed

- `ocra metrics` and the ocra Cloud upload credit a fixed or dismissed finding to the reviewer that reported it, even when the review that sees it fixed no longer has a finding with its fingerprint.
