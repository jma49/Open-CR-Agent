---
"@open-cr-agent/cli": patch
---

### Fixed

- A call to ocra Cloud that could not be sent names its network or certificate error instead of only `fetch failed`, and says to use `NODE_EXTRA_CA_CERTS` for a server whose certificate authority Node does not trust.
