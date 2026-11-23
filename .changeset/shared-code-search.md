---
"@open-cr-agent/vcs-local": patch
"@open-cr-agent/runtime-direct": patch
---

### Changed

- Code search on a large repository costs less: one `git grep` runs at a time, shared by the searches that wait for it and stopped once each has its matches, and the `direct` runtime runs the tool calls of one step together. A review of 398 files in a repository of 32,000 took 64 s instead of 99 s with a model that answers at once; results are the same ([#695](https://github.com/jma49/Open-CR-Agent/pull/695)).
