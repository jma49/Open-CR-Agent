---
"@open-cr-agent/cli": minor
"@open-cr-agent/core": minor
"@open-cr-agent/cloud-contract": minor
---

### Added

- `ocra fix --json` and each item of `ocra mend --json` carry `cause` when the reason is `failed`: `timeout`, `quota`, `refused`, `unavailable`, `invalid_output` or `unknown`, never the endpoint's own message (`FIX_FAILURE_CAUSES` in `@open-cr-agent/cloud-contract`, `CALL_FAILURES` in `@open-cr-agent/core`).
