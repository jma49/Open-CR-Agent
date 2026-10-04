---
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
---

### Added

- While signed in, a review also takes the limits, `verify`, `judge`, `sampling`, `include`, `exclude` and path rules from your ocra Cloud account, under the configuration: what the configuration sets wins, and `include`, `exclude` and rules combine (ADR-0027).
- `ocra review --plan` reads the account settings too and lists every setting with its source (`file`, `account`, `file+account` or `default`), in text and in the JSON plan's `settings`; offline, it warns and shows the configuration alone.
- The JSON report's `provenance.rules` lists the rules a review was given with their `source`, and `provenance.accountSettings.version` the account settings used; the configuration hash covers them. `ReviewOptions.rules` takes an optional `source` per rule (`SourcedRule`).

### Changed

- An account setting that does not match the configuration's schema is now ignored alone, with a warning naming it, instead of all of them; unknown keys are ignored with one warning, and `providers`, `extends` and `github` from the account are always ignored. Account models must be `ocra-<provider>/<model>`.
- A failure to reach ocra Cloud for the settings is a warning, not an error.
