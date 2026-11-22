---
"@open-cr-agent/cli": minor
"@open-cr-agent/cloud-contract": minor
---

### Added

- A signed-in review whose ocra Cloud account shares findings relays its progress to ocra Cloud as it runs and prints where to watch it, so the run can be shared with others to watch and comment on; best effort, never slowing the review, and off with `--no-upload`.
- `@open-cr-agent/cloud-contract`: `liveBatchSchema`, `liveAnswerSchema`, `LIVE_EVENTS_PATH` and the live relay's limits.
