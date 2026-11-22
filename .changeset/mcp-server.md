---
"@open-cr-agent/cli": minor
---

### Added

- `ocra mcp`: a Model Context Protocol server on standard input and output with one `review` tool, so a coding agent such as Claude Code, Cursor or Codex can review its changes with ocra; its arguments only narrow the review, as `ocra serve`'s do, and its answer marks the findings as untrusted data.
