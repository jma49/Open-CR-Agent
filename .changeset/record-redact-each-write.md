---
"@open-cr-agent/runtime-direct": patch
---

### Fixed

- `OCRA_RECORD_DIR` recordings leave out a key renewed during the run and a key with a quote or backslash.
- A recording that cannot be written is a warning; the model request is no longer sent again.
