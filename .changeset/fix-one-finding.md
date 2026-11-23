---
"@open-cr-agent/cli": minor
"@open-cr-agent/core": minor
"@open-cr-agent/cloud-contract": minor
---

### Added

- `ocra fix` writes a checked fix for one finding a review reported (`--finding`, `--head`, `--json`), prints it and commits nothing; it exits 3 when the finding's code is gone or the head moved.
- `fixResultSchema`, `FIX_OUTCOMES`, `FIX_REASONS` and `FIX_REJECTIONS` in `@open-cr-agent/cloud-contract`; a shared finding carries `lowConfidence`.
