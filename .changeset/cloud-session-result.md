---
"@open-cr-agent/cli": patch
---

### Fixed

- A review whose ocra Cloud session ended warns `your ocra Cloud session ended: run ocra login`, and one that cannot reach ocra Cloud warns once that it runs without the account's rules, limits (`maxCostUsd` included), models, memory and upload, instead of silently running signed out; with an `ocra-` model the error says ocra Cloud could not be reached rather than asking to sign in.
- A 401 for a live token renews the session once and retries once; a 404 for the account settings is no settings, without a warning.
- `ocra login` saves the session even when it cannot read the login.
