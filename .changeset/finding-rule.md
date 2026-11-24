---
"@open-cr-agent/core": minor
"@open-cr-agent/cloud-contract": minor
"@open-cr-agent/cli": minor
---

### Added

- A finding names the repository rule or learning it applies in the report's `rule` (`{ kind, id }`) and in the Cloud upload; `.ocra/rules.json` rules take an optional `id`, and every rule's id is in the report's provenance (ADR-0080).
