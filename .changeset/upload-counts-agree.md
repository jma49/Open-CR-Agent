---
"@open-cr-agent/cli": patch
---

### Fixed

- The counts sent to ocra Cloud agree with the exit code: a review with a critical finding it could not verify is uploaded as incomplete, and timed-out tasks count as failed, as they do per reviewer.
