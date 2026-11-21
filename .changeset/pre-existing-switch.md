---
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
---

### Added

- `showPreExisting` (default `true`) in `.ocra/config.json`, and `stages.showPreExisting` in `ReviewOptions`: `false` leaves findings Verify traced to code from before the change out of the report.

### Changed

- A pre-existing finding never counts towards the verdict, so it cannot block a change.
