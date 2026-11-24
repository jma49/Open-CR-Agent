---
"@open-cr-agent/vcs-platform": patch
---

### Changed

- The summary comment counts findings once, naming only the severities found (for example "**1 warning** · risk tier `trivial`"), and no longer repeats the counts as its summary when the judge wrote none. `ocra review` in a terminal drops that repeated line too.
