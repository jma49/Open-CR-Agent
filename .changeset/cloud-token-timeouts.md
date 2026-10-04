---
"@open-cr-agent/core": patch
"@open-cr-agent/cli": patch
---

### Fixed

- A run with ocra Cloud models and `"runtime": "direct"` renews the gateway token before it expires, so runs longer than an hour keep their model calls; with `opencode`, the token is sized to outlive `runTimeoutMinutes`, with a warning when no token can.
- `taskTimeoutMinutes` and `runTimeoutMinutes` above 35791 (about 24.8 days) are refused instead of making every task time out at once; `review()` cuts a longer `taskTimeoutMs` or `runTimeoutMs` to that limit.
