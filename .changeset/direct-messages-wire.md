---
"@open-cr-agent/runtime-direct": minor
"@open-cr-agent/cli": minor
"@open-cr-agent/core": minor
"@open-cr-agent/cloud-contract": minor
---

### Added

- A provider declared with `"type": "anthropic"` runs on the direct runtime through Anthropic's Messages API, with the prompt cache at every step and the effort as `output_config.effort`.
- `ocra-<provider>/<model>` reaches an ocra Cloud provider that lists only a Messages endpoint, such as `ocra-anthropic/<model>`.
