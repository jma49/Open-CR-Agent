---
"@open-cr-agent/core": minor
"@open-cr-agent/cloud-contract": minor
"@open-cr-agent/cli": minor
---

### Added

- Every review keeps its trace (ADR-0081): `.ocra/sessions/<id>/trace.json` and `report.trace` lay the run out in time (stages, each task's timed attempts, every plain model call with its model, each reported finding's fate and reason), with no code, prompt or answer text.
- The ocra Cloud upload carries the trace with the findings, redacted and bounded (`sharedTraceSchema`, `MAX_TRACE_*`).
- A `model_called` session event per plain completion; `CompletionResult.model` names the model that answered.
