---
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
---

### Added

- `ocra review --without <sources>` (`ReviewMode.without`) leaves context sources out of every review prompt, to measure what each is worth.
- `ocra review --plan --format json` gives each task's first prompt by source: tokens, cuts and duplicated lines (`context`).

### Changed

- Review prompts hold the changed-files list to 150 files, accepted findings to the last 20 on the bundle's files, the repository's rules to 12,000 characters, and task and learning titles to 300 characters; smaller inputs render as before.
