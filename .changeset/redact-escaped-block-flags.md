---
"@open-cr-agent/cloud-contract": patch
---

### Security

- The redaction pass for shared findings also replaces a secret value in a JSON string whose quotes are escaped, the lines of a YAML block scalar (`password: |`), the argument after a flag such as `--password` or `--api-key`, a password glued to `mysql -p`, a quoted value cut by a line break, a `Bearer` or `Basic` credential on the next line, and a lowercase `bearer` or `basic` credential of 16 or more characters with a digit.
