---
"@open-cr-agent/cloud-contract": patch
"@open-cr-agent/cli": patch
---

### Fixed

- `configSchema.safeParse` returns an issue at the provider's or tracker's address when that address is not a URL, instead of throwing a `TypeError`; ocra reports such a `.ocra/config.json` as invalid instead of crashing.
