---
"@open-cr-agent/cli": patch
---

### Fixed

- ocra Cloud's providers list is checked before use: an answer that is not a list stops the review with an error instead of a crash, a malformed entry is left out, and the effort style a provider lists (`openai` or `openrouter`) is used, an unknown one ignored with a warning.
