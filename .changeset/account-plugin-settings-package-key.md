---
"@open-cr-agent/cli": patch
---

### Fixed

- `pluginSettings` from your ocra Cloud account are looked up by the package name the account lists, as ocra Cloud stores them, so a plugin whose package and plugin names differ now gets its settings.
