---
"@open-cr-agent/cli": minor
"@open-cr-agent/cloud-contract": patch
---

### Security

- A signed-in review sends findings and their code only when this machine agreed: `ocra login` records that when the account shares findings, and a review that finds sharing off forgets it. After turning sharing on in ocra Cloud, run `ocra login` again on each machine.
- The account's `exclude` applies only when your configuration sets none, so a repository that lists its own exclusions (even `[]`) cannot have files hidden from review by its ocra Cloud account.
- `GATEWAY_PATH` refuses `.`, `..` and empty segments, so a gateway path ocra Cloud lists stays under its provider.
