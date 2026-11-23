---
"@open-cr-agent/cli": minor
"@open-cr-agent/core": minor
"@open-cr-agent/cloud-contract": minor
"@open-cr-agent/vcs-platform": minor
---

### Added

- `minInlineSeverity` and `maxInlineComments` (`--min-inline-severity`, `--max-inline-comments`) post fewer inline comments; the rest are listed in the summary and kept in the report (`inline` in the JSON report).
- `ultra` as a configuration key, and `--no-ultra` to turn off an `ultra` the configuration or the ocra Cloud account turns on.
- ocra Cloud account settings take `minInlineSeverity` and `maxInlineComments`.
