---
"@open-cr-agent/cloud-contract": patch
"@open-cr-agent/runtime-direct": patch
---

### Fixed

- Redaction replaces a flag's secret argument followed by `;`, `,` or `)`, as in a shell command line.
- Model exchange recordings leave out the key a request was sent with when the key is renewed before the answer arrives.
