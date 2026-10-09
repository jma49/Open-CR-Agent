---
"@open-cr-agent/cli": patch
---

### Fixed

- `ocra metrics` and the ocra Cloud upload no longer count a task that `--resume` reused in the per-reviewer cost of the run that reused it; the run that paid for it counts it, so per-reviewer cost adds up to the run total.
