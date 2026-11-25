---
"@open-cr-agent/cli": patch
---

### Fixed

- `ocra init --github` uses the supported key declared by the providers in the retained model chains when they all use the same key, without requiring its value in the shell.
