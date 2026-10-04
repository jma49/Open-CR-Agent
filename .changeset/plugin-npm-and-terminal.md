---
"@open-cr-agent/cli": patch
---

### Security

- Account settings named on the terminal are escaped like other untrusted text.
- `ocra plugins allow` runs npm from the plugin directory, so the current project's npm configuration does not apply, and refuses a package whose registry entry lists no integrity.

### Changed

- `NpmRunner` takes the directory to run npm in as a second argument; a custom runner should run npm there.
