---
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
"@open-cr-agent/vcs-platform": minor
"@open-cr-agent/cloud-contract": minor
---

### Added

- A walkthrough of the change in the summary comment of pull and merge request reviews: an overview, the files grouped in reading order and a sequence diagram when the flow crosses three or more components; the `walkthrough` setting turns it off, or on for local reviews, and the JSON report carries it.
- A review shared with ocra Cloud carries its walkthrough, redacted like the findings, when the account shares findings (`walkthrough` in the upload contract).
- The `writer` role, which writes the walkthrough on the standard tier; `roles.writer` sets its models and effort.
