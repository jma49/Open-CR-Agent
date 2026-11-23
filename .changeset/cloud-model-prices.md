---
"@open-cr-agent/cli": minor
"@open-cr-agent/cloud-contract": minor
---

### Added

- A model through ocra Cloud is priced as ocra Cloud lists it, so the reported cost and `--max-cost-usd` count it; a model it lists no price for stays unpriced, with a warning naming it.
- `@open-cr-agent/cloud-contract` exports `modelPriceSchema`, and a provider entry carries `prices`.
