---
"@open-cr-agent/runtime-opencode": patch
---

### Changed

- A review on the `opencode` runtime sends one model request fewer per task: the done tool ends the session, and its result is no longer sent back to the model. A review of 20 files in 41 tasks sent 193 requests and 2.34 million input tokens instead of 234 and 2.91 million; findings are the same ([#698](https://github.com/jma49/Open-CR-Agent/pull/698)).
