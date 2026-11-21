---
"@open-cr-agent/cli": minor
---

### Added

- `ocra serve`: a review service on 127.0.0.1 that starts reviews over HTTP and streams each one's events (Server-Sent Events, the contract's `reviewEventSchema`); cancel is its only mid-run command.
