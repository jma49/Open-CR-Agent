---
"@open-cr-agent/cli": patch
---

### Fixed

- On a Windows runner the Action starts npm without a shell, so a runner directory holding `&` or `^` no longer breaks its install step.
