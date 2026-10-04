---
"@open-cr-agent/cloud-contract": patch
---

### Added

- Error code `upstream_redirect` (502): ocra Cloud's gateway refuses a provider's redirect rather than resend the key elsewhere.

### Fixed

- The parsed types of the per-agent settings name their keys (`reviewers.<id>.models`, `roles.<role>.effort`) instead of `{}`.
