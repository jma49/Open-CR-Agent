---
"@open-cr-agent/cli": patch
---

### Security

- The workflows `ocra init --github` writes pin `actions/checkout` by commit, like the Action, so a moved tag cannot change what runs with the workflow's secrets. The GitHub guide's recipes pin every action by commit too. A workflow written by an earlier version keeps the tag: pin it as the guide shows.
