---
"@open-cr-agent/core": minor
"@open-cr-agent/runtime-opencode": minor
---

### Added

- The `opencode` runtime sends the configured reasoning effort: `reasoningEffort` for OpenAI, a thinking budget for Claude 4+ and Gemini 2.5, `thinkingLevel` for Gemini 3, one OpenCode variant per model and level.
- `effortCapability(model)` in `@open-cr-agent/core`: ocra's table of the parameter and levels a model takes; `AppliedSettings.unsupported` names models a level was left out for.

### Changed

- A level the capability table does not list for a model is left out of its calls on `opencode`, with one warning per agent; calls that send an effort run without the configured temperature.
