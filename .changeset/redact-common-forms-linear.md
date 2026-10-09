---
"@open-cr-agent/cloud-contract": minor
"@open-cr-agent/cli": patch
---

### Security

- Shared findings are redacted of more secret forms: unquoted `password: …` and `NAME=…` values, `curl -u user:…`, short `Bearer` and `Basic` credentials, PGP private key blocks, and hex tokens after a prefix such as `dop_v1_` ([#513](https://github.com/jma49/Open-CR-Agent/issues/513)).
- `redact()` takes time linear in its input; crafted text no longer stalls it, and the CLI cuts each field to 4 KB before redacting it ([#515](https://github.com/jma49/Open-CR-Agent/issues/515)).

### Added

- `redactField()` in `@open-cr-agent/cloud-contract`: one shared finding field cut at `MAX_FIELD`, then redacted, as the CLI sends it.

### Changed

- `sharedFindingSchema` holds `title` and `body` to `MAX_FIELD` characters (a finding with a longer one is left out) and reads a longer `category`, `suggestion` or `code` as absent.
