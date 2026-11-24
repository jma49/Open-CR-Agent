---
"@open-cr-agent/core": patch
"@open-cr-agent/cloud-contract": patch
"@open-cr-agent/cli": patch
---

### Fixed

- `ocra mend --checks` reads the last lines of the step that failed (GitHub Actions) or of the job's script (GitLab), not of the whole log, where steps that ran after the failure could push it out. `checkLogTail` in the contract does the same.
