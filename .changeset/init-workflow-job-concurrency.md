---
"@open-cr-agent/cli": patch
---

### Fixed

- In the fork-safe workflow `ocra init --github` writes, a run the job's `if:` skips (an unrelated label, an outside author's push) no longer cancels the review in progress: the concurrency group, now on the review job, repeats the condition, so such a run gets a group of its own. A workflow written by an earlier version keeps the problem: change its `concurrency` block as the GitHub guide shows.
