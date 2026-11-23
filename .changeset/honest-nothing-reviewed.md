---
"@open-cr-agent/cli": patch
---

### Fixed

- A review that reviewed nothing no longer uploads the verdict `approved` to ocra Cloud; it uploads none.
- "Nothing was reviewed" now says why: the model provider refused every call (a daily limit or a rate limit), or the first task error. The JSON report's failed tasks carry `quota` when every model they could use was out of quota.
