---
"@open-cr-agent/core": patch
---

### Fixed

- With `--max-cost-usd`, a review task whose last spend report reaches the review share after the agent finished counts as completed, not cancelled: its files no longer count as unfinished, exit with `3`, and get reviewed again on the next push.
