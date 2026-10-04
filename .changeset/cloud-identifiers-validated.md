---
"@open-cr-agent/cli": patch
"@open-cr-agent/runtime-opencode": patch
---

### Security

- Model ids, provider names and gateway paths from ocra Cloud are validated before they reach the runtime configuration; others are dropped with a warning.
- The OpenCode runtime refuses `{` and `}` in every declared provider's id, address and model names, not only those from a configuration file.
