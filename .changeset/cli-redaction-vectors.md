---
"@open-cr-agent/cli": patch
---

### Security

- Shared findings: the redaction pass before upload matches ocra Cloud's and runs the same test vectors. It now also covers a finding's file path and category, keys that contain `/`, hex keys, the password in a URL, Slack and Discord webhook URLs, and quoted values assigned to names such as `password` or `api_key`. Hex runs of 32 or more characters, digests included, now read `[redacted]`.
