---
"@open-cr-agent/cli": patch
"@open-cr-agent/cloud-contract": patch
"@open-cr-agent/core": patch
"@open-cr-agent/runtime-direct": patch
"@open-cr-agent/runtime-opencode": patch
"@open-cr-agent/vcs-github": patch
"@open-cr-agent/vcs-gitlab": patch
"@open-cr-agent/vcs-local": patch
"@open-cr-agent/vcs-platform": patch
---

### Security

- Require zod 4.6.6 or later, which no longer exhausts memory validating oversized constrained collections (GHSA-mrhx-c7xc-m3w5).
