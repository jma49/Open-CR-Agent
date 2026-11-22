---
"@open-cr-agent/core": patch
"@open-cr-agent/cli": patch
---

### Changed

- Review tasks on files under sensitive paths (`auth/`, CI workflows and the like) start first, so a run stopped by the spend or task limit has reviewed those files; `--plan` lists tasks in that order, and task ids are unchanged.
