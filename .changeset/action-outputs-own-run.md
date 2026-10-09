---
"@open-cr-agent/cli": patch
---

### Security

- The Action's outputs (`verdict`, `run-id`, `findings`, `report`) come from the session the run wrote, never from a session that came with the pull request, and are not read through a symbolic link.
