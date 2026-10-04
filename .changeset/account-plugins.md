---
"@open-cr-agent/cli": minor
---

### Added

- `ocra plugins allow <name>@<version>`, `ocra plugins deny <name>` and `ocra plugins list`: allow on this machine a plugin your ocra Cloud settings name. `allow` shows the package and its publisher, installs that exact version with install scripts off into `~/.config/ocra/plugins/`, and records its integrity (ADR-0027).
- A signed-in local review loads the plugins your ocra Cloud settings name that this machine allowed, from that directory only, with the account's `pluginSettings` for them; never for `--pr`, `--mr` or with `--no-repo-config`. A plugin not allowed is skipped with one warning.
