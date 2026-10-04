---
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
"@open-cr-agent/vcs-platform": patch
---

### Added

- A signed-in review applies the findings your ocra Cloud account remembers for the repository together with `.ocra/memory.json` (a finding both list counts as the repository's), and prints how many the account's memory hid (ADR-0028).
- The JSON report's `remembered` entries carry their `source` (`repository` or `account`); `ReviewOptions.accountMemory` takes the account's entries, and `MemorySource` and `RememberedEntry` are exported.
- When the account shares findings, the upload carries each finding (fingerprint, reviewer, severity, category, verification, file, lines, title, body, suggestion, quoted code), with secret-looking tokens redacted first and bounded to 200 findings, 4 KB per field and 256 KB in all.
- While the account shares findings, the repository hash uses the account's salt, kept in `account-salt` beside the credentials, so it matches on all of the account's machines.

### Changed

- The pull request summary says how many findings the reviewing account's ocra Cloud memory hid, apart from those `.ocra/memory.json` hid.
- `ReviewReport.remembered` is now `RememberedEntry[]`: code that builds a `ReviewReport` itself sets each entry's `source`.
