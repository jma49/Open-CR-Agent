---
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
---

### Added

- `guidelineScope` (`--guidelines`): give each review task every section of `AGENTS.md` (`all`, the default), the sections for its files (`matched`), or give them only to the `agents-md` reviewer (`reviewer`).

### Changed

- `AGENTS.md` longer than 20,000 characters is no longer cut mid-section: sections that do not fit are left out whole and listed by heading.
