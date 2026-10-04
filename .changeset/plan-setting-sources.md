---
"@open-cr-agent/cli": patch
---

### Fixed

- `ocra review --plan` names each setting's real source: `shared` for a shared configuration (`extends`) and `env` for `OCRA_MODEL_*` and `OCRA_EFFORT_*`, which it reported as `file`; a combined list names the layers it combines, such as `shared+account`. The sources are recorded by the merge that applies the settings, so the plan cannot drift from the review.

### Changed

- The line "From your ocra Cloud settings: …" names the settings in the order `--plan` lists them.
