---
"@open-cr-agent/core": patch
"@open-cr-agent/cli": patch
"@open-cr-agent/vcs-platform": patch
---

### Fixed

- The review summary and the pull request summary no longer count memory entries without a source as hidden by your ocra Cloud memory.
- A session key or upload salt ocra cannot read (owned by another user, say, after `sudo ocra`) is no longer replaced: the review warns, and sends nothing to ocra Cloud when it needed that salt.
- `--resume` on a session whose log is empty says the log is empty.
- `--output` refuses, before any model call, a path that exists but is not a regular file (a named pipe, a device), as it refuses links such as `/dev/stdout`; it leaves no temporary file when ocra exits before the rename.
