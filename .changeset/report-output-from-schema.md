---
"@open-cr-agent/core": minor
---

### Changed

- `ReportOutput`, `OutputFinding` and `OutputPriorFinding` are derived from `reportOutputSchema`; the report's JSON is unchanged.
- `reportOutputSchema` rejects an optional field present with the value `undefined`; JSON input is unaffected.
