---
"@open-cr-agent/vcs-platform": patch
"@open-cr-agent/vcs-github": patch
"@open-cr-agent/vcs-gitlab": patch
---

### Fixed

- A request GitHub or GitLab refuses has at most 64 KB of its answer read, instead of all of it; the error still quotes its first 500 characters.
- The GitHub and GitLab clients take an abort signal that also ends the wait before a retry (up to 60 seconds on a rate limit), not only the request in flight.
