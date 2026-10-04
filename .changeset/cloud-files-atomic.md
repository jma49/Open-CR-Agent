---
"@open-cr-agent/cli": patch
---

### Fixed

- The ocra Cloud credentials and salt files are written atomically (0600, temporary file and rename); a credentials file that holds no session reads as signed out with one warning instead of failing every review, and `ocra logout` removes it.
