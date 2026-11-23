---
"@open-cr-agent/cli": minor
"@open-cr-agent/core": minor
"@open-cr-agent/cloud-contract": minor
---

### Added

- `ocra mend` runs one round of the fix loop over accepted findings (`--findings`, `--level propose|commit`, `--state`, `--head`, `--protect`, `--json`): a checked fix each, a gate over what may be edited, one verifier call, then one unforced commit or the edits printed; it exits 3 when the head moved or the branch cannot be written to.
- `mendResultSchema`, `mendStateSchema`, `mendFindingsSchema` and the `MEND_*` vocabularies in `@open-cr-agent/cloud-contract`.
