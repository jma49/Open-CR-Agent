---
"@open-cr-agent/cli": patch
---

### Security

- `ocra metrics --format json` escapes C1 and bidirectional control characters from session data, as the other JSON outputs already did.
