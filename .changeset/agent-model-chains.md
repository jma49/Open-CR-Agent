---
"@open-cr-agent/core": minor
"@open-cr-agent/runtime-direct": minor
"@open-cr-agent/runtime-opencode": minor
"@open-cr-agent/cli": minor
---

### Added

- A model or failback chain per reviewer (`reviewers.<id>.models`) and per role (`roles.<verifier|judge|helper>.models`); an agent without one keeps its tier's chain (ADR-0025).
- Task specs and completion requests carry an agent's own chain as `models`, and runtime factories receive every agent chain in `agentModels`; both built-in runtimes run those calls on it, with failback and a circuit breaker shared per model.
- The JSON report's `provenance.agents.<id>.models` records each agent's chain, and `--plan` shows each task's chain.
