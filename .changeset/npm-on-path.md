---
"@open-cr-agent/cli": patch
---

### Fixed

- The Action finds npm's sigstore client where Homebrew and similar installs keep npm, away from the Node binary, so it fetches the trusted root before checking signatures there too.
