---
"@open-cr-agent/cli": patch
---

### Fixed

- The Action no longer fails now and then with "1 package has an invalid attestation": it fetches sigstore's trusted root once before `npm audit signatures` verifies the packages in parallel.
