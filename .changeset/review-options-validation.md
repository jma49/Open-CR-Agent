---
"@open-cr-agent/core": patch
---

### Fixed

- `review()` refuses invalid `limits` (a concurrency that is not a whole number of at least 1, a timeout that is not positive, a negative or `NaN` spend limit, a fractional task cap) with `CONFIG_INVALID` before it starts; `concurrency: NaN` used to start no task and crash, and a negative timeout threw from inside the run.
