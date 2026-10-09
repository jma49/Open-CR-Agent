---
"@open-cr-agent/core": patch
---

### Fixed

- Rate limits that reach a model while it is paused, as when tasks running at once are refused together, count as that pause: one burst no longer drops the model for the run.
- A task that waited out a rate limit no longer sends a request to a model another task found out of quota in the meantime.
