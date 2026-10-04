---
"@open-cr-agent/cloud-contract": minor
"@open-cr-agent/cli": patch
---

### Added

- `@open-cr-agent/cloud-contract`: the wire contract between the CLI and ocra Cloud as one package of Zod schemas and constants (upload, preferences, memory and device sign-in shapes, upload limits, verdict, tier and effort vocabularies, provider ids, error codes), with the redaction pass and its test vectors. Its first publish is by hand, before the release that includes it.

### Changed

- The CLI reads and sends ocra Cloud's shapes through `@open-cr-agent/cloud-contract`; what it sends and accepts is unchanged.
