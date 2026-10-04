---
"@open-cr-agent/cli": patch
---

### Security

- `ocra login` opens only the sign-in page's own address on the server in use, and on Windows opens it without a command interpreter; any other address is printed for the user to open.
