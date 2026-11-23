---
"@open-cr-agent/core": minor
"@open-cr-agent/cloud-contract": minor
"@open-cr-agent/cli": minor
---

### Added

- Verify starts while review tasks still run: a file's findings are checked once every task reviewing it has ended, and a critical finding the verifier confirms is settled, so it is known before the review ends. `ocra review` prints a `Confirmed:` line for each, `ocra serve` and the live relay send it with `settled: true`, and core emits `findings_verified` ([ADR-0074](https://github.com/jma49/Open-CR-Agent/blob/main/docs/adr/0074-early-findings.md)).
- `ocra-eval perf` reports when the verifier answered for the first file, and takes `firstVerifiedMs` as a budget.

### Changed

- The judge no longer merges a settled finding into another: two confirmed critical findings on different lines that it calls duplicates both stay in the report.
