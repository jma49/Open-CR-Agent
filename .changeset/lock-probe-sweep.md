---
"@open-cr-agent/cli": patch
---

### Fixed

- On Windows, an empty `credentials.json.lock.<hex>.probe` file left in the config directory by an ocra process killed at the wrong moment is removed by a later run once it is older than a stale lock.
