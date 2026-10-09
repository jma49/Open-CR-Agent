---
"@open-cr-agent/core": patch
"@open-cr-agent/vcs-local": patch
---

### Security

- Secret-looking paths, files renamed away from them and `.git/` are refused under any spelling a case-insensitive file system opens as the same name, Unicode case variants and invisible characters included, not only under ASCII case variants.
- Workspace reviews read a file only under its own name: on a case-insensitive file system, such as macOS's by default, another spelling of the name no longer opens it.
