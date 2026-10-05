---
"@open-cr-agent/core": patch
---

### Fixed

- The published packages no longer end their files with `sourceMappingURL` comments naming maps they do not ship, so bundlers that load ocra's packages stop warning "Failed to load source map".
