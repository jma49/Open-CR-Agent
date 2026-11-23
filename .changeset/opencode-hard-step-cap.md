---
"@open-cr-agent/runtime-opencode": patch
---

### Fixed

- On the `opencode` runtime a turn that runs past its step cap is stopped and counts as one that used every step. OpenCode's cap only asks the model to stop, so a model that kept calling tools, or an endpoint that answered a streamed request without a stream, made requests until the task's timeout.
