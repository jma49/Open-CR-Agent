---
"@open-cr-agent/core": minor
---

### Added

- `ReviewerScope.span`: a reviewer with `span: "change"` reviews the change as a whole, in as few tasks as its size allows, instead of once per bundle.

### Changed

- The docs and agents-md reviewers review the change as a whole: one task each, or a few for a change of more than 20 files or 120,000 characters of diff. A large change needs about a third fewer review tasks and reaches the task limit later.
