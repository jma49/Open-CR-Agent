---
"@open-cr-agent/cli": minor
---

### Added

- `ocra init --github` also writes `.github/workflows/ocra-commands.yml`: `@ocra review` reviews a pull request again, and ocra answers any other `@ocra` mention in its thread.

### Changed

- ocra's comment commands are spelled `@ocra review`, `@ocra override`, `@ocra dismiss` and `@ocra remember`, as ocra Cloud spells its own. A comment that gives a command is no longer answered as a question.

### Deprecated

- `/ocra review`, `/ocra override`, `/ocra dismiss` and `/ocra remember` still work and will be removed in a later release.
