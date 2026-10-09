---
"@open-cr-agent/cli": patch
---

### Fixed

- A signed-in review whose config directory cannot be written runs anyway: it warns, uses the account's salt it was just sent, and sends nothing to ocra Cloud only when no salt can be had.
- On `opencode`, a run longer than about 50 minutes on `ocra-` models no longer renews the ocra Cloud token at every start when a new token would last no longer.
- Checking whether your ocra Cloud account remembers findings reads no more than it needs, and every ocra Cloud answer is read up to a size limit.
- The ocra Cloud session and the salts are flushed to disk before they replace the old file, and on Windows the replacement is tried again while another program holds the file a moment.
