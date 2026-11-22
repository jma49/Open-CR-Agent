---
"@open-cr-agent/vcs-gitlab": patch
---

### Fixed

- `ocra review --mr` reads the project from an HTTPS `origin` of a GitLab installed under a relative URL root (`CI_API_V4_URL` such as `https://example.com/gitlab/api/v4`).
