---
"@open-cr-agent/cli": patch
---

### Security

- `ocra review --output` no longer writes through a symbolic link: a link at the output path, or at a directory on the way inside the repository, is refused with `ACCESS_DENIED` (exit `2`) before any model call, and the file is replaced whole in one rename.
