---
"@open-cr-agent/cli": patch
---

### Fixed

- On `"runtime": "direct"`, a gateway token that could not be renewed before it expired is still renewed once ocra Cloud answers again, instead of failing every later model call through ocra Cloud for the rest of the run.
