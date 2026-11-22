---
"@open-cr-agent/cloud-contract": minor
---

### Added

- The contract exports `configSchema`, the Zod schema `.ocra/config.json` is checked against, with its refinements (endpoints, credential variable names, unique check ids, providers' models), and `configJsonSchema()`.
