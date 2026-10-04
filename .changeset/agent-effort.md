---
"@open-cr-agent/cli": minor
"@open-cr-agent/core": minor
"@open-cr-agent/runtime-direct": minor
---

### Added

- Reasoning effort per model tier (`effort`, `OCRA_EFFORT_<TIER>`), per reviewer (`reviewers.<id>.effort`) and per role (`roles.<verifier|judge|helper>.effort`), sent by the `direct` runtime as `reasoning_effort`, or `reasoning.effort` for a provider declared with `"effort": "openrouter"`; a call that sends an effort sends no temperature or seed, and an endpoint that refuses the parameter is asked again without it.
- The report's provenance lists each agent's tier, effort and whether it was applied (`provenance.agents`), and `ocra review --plan` shows each task's effort.
- `AgentTaskSpec.effort`, `CompletionRequest.agent` and `effort`, and the optional `AgentRuntime.appliedTo()` let a runtime plugin take the effort and say what it applied.
