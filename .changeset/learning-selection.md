---
"@open-cr-agent/core": minor
---

### Added

- `ReviewOptions.learnings`: each review task is given the team's learnings that apply to its files, selected without a model, and the report lists them under `learnings` (ADR-0037).
- Learnings that apply past the per-task budget are listed by id and title (up to 10), and reviewers read one with the new `read_learning` tool (`ReviewContext.readLearning`).
