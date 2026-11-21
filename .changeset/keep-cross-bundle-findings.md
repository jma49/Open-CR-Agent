---
"@open-cr-agent/core": minor
"@open-cr-agent/eval": minor
---

### Changed

- A finding a reviewer reports on another changed file, outside its bundle, is kept (once, by fingerprint) instead of dropped; only findings on files outside the review are dropped.
- The `finding_dropped` session event's reason is now `outside_review` (was `outside_bundle`), and the eval funnel's drop stage of the same name follows.
