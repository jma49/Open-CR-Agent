---
"@open-cr-agent/cli": minor
"@open-cr-agent/cloud-contract": minor
---

### Added

- A shared finding carries its `evidence` to ocra Cloud (at most 5 one-line entries of 300 characters, redacted like its other text), so the web can show it as a pull request comment does; `MAX_EVIDENCE` and `MAX_EVIDENCE_FIELD` in `@open-cr-agent/cloud-contract`.
