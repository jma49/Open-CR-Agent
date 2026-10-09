---
"@open-cr-agent/runtime-direct": patch
---

### Added

- `OCRA_RECORD_DIR`: the direct runtime writes every model request and the answers it got to that directory (keys redacted, owner-only files), so a run can be read afterwards or replayed in tests without a model.
