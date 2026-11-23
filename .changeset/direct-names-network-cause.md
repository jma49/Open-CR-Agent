---
"@open-cr-agent/core": minor
"@open-cr-agent/runtime-direct": patch
---

### Fixed

- On the `direct` runtime a request that could not be sent names its cause instead of only `fetch failed`: the DNS, connection or TLS error, and for a certificate authority Node does not trust, that `NODE_EXTRA_CA_CERTS` fixes it.

### Added

- `fetchFailure(error)` in `@open-cr-agent/core`: that message, for runtime plugins.
