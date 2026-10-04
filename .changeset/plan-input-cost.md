---
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
---

### Added

- `ocra review --plan` estimates each task's input cost at the input price of its chain's first model, and the total; models priced at 0 or through ocra Cloud show as unpriced, catalog-priced models as of unknown price. The plan JSON carries `inputCost` per task and in total.
