---
"@open-cr-agent/runtime-direct": patch
---

### Fixed

- The direct runtime now works with Gemini behind an OpenAI-compatible endpoint, such as Vertex AI's: a tool call goes back to the model with its `type` and with the thought signature Gemini attached (`extra_content`). Before, the second request of every review task was refused with HTTP 400.
