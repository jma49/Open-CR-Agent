---
"@open-cr-agent/cli": minor
"@open-cr-agent/core": minor
"@open-cr-agent/runtime-direct": minor
---

### Added

- `ocra mend` fixes findings its local lane cannot place (code found more than once, a span over 30 lines, a fix that needs other lines or files) through a fixer task with the read tools and one `edit` tool over a copy of the head in memory, on the `direct` runtime; the gate and the verifier check its edits like any other.
- `AgentTaskSpec.toolset` (`TaskToolset`), `AgentRuntime.toolsets` and `readTools` in `@open-cr-agent/core`: a task's own tools in place of the review's, for a runtime that declares it runs them.
