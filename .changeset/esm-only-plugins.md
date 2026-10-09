---
"@open-cr-agent/cli": patch
---

### Fixed

- A plugin package whose `exports` name an entry for `import` only loads, from the repository's dependencies and from your ocra Cloud account; a package with both entries now loads its `import` entry.
