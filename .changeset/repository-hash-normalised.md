---
"@open-cr-agent/cli": patch
---

### Fixed

- ocra Cloud gets one repository hash per repository, whatever form its remote URL takes (`git@host:o/r`, `ssh://`, `https://`, with a user, a port, a trailing `/` or `.git`), so SSH clones and HTTPS CI group together and match the account's memory.
- With `--pr` or `--mr`, the hash is the pull or merge request's repository, not the checkout's origin.
- When ocra Cloud cannot be reached, a review hashes with the account salt saved at the last answer instead of this machine's.
- A review warns once when the account remembers findings but does not share findings, so its memory cannot apply.

### Changed

- After upgrading, a repository whose remote is written in SSH form, or with a port or a trailing `/`, gets a new hash once: earlier uploads and account memory recorded under the old hash do not match it until they are recorded again. HTTPS remotes keep their hash.
