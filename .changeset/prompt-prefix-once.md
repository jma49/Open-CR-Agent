---
"@open-cr-agent/core": patch
---

### Changed

- A run renders its list of changed files once for all its tasks and checks each path against the access policy once; a scripted review of 669 files spent a fifth less time.
