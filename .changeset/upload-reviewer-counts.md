---
"@open-cr-agent/cli": minor
---

### Added

- The counts sent to ocra Cloud after a review now include, per reviewer, its tasks, failed tasks, findings by severity, cost, and fixed and dismissed findings, plus the findings by verification and the run's fixed and dismissed totals. Still numbers only (ADR-0028).
- Your ocra Cloud account can turn on `ultra`: a signed-in review then runs as if `--ultra` were given, prints it among the settings it took from the account, and `--plan` lists it with its source.
