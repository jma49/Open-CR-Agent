---
"@open-cr-agent/core": patch
---

### Changed

- `isBlocking` takes the change request's `override` as typed by `ChangeRequest`, and `PreviewOptions` no longer accepts `full`, which `mode.full` already sets.
