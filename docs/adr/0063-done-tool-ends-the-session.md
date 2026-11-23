# ADR-0063: The done tool ends an OpenCode session

- Status: accepted
- Date: 2026-11-23

## Context

OpenCode hands every tool result back to the model. The done tool's result ("Done.") is one of them, so each review task on the OpenCode runtime ended with a request that carried the whole conversation only to hear that the review was over. ADR-0061 measured it: one request per task and about a quarter more input tokens, the largest request of the task each time. The direct runtime stops at the done tool.

ADR-0061 left it alone because aborting the session when the tool runs loses the usage of the step that called it: OpenCode records a step's tokens when the step ends, and the cost report must stay whole.

OpenCode 1.18.32 ends a session after a step in three cases: the model answers without a tool call, the step fails, or a tool call's permission request is rejected. Only the third is in ocra's hands, and it lets the step finish, so its tokens and cost are recorded as for any other step.

## Decision

1. **The done tool asks for permission, and ocra rejects it.** The review and wrap-up agents carry `ask` for the done tool (`opencode-config.ts`). The runtime follows OpenCode's event stream and rejects every request for that permission (`done-tool.ts`); OpenCode marks the call as not run, ends the step and stops. No other permission is answered: a request ocra does not expect stays unanswered, as before.
2. **Nothing reads the done tool's result.** A task is done when the call is in the session, whatever its state (`summarizeSession`), which is what the direct runtime's loop does with the call. The tool's `execute` is not reached on this runtime.
3. **A prompt never switches the done tool on.** A prompt's `tools` become the session's permissions, and `true` would allow what the agent must ask for, so the wrap-up turn lists only the reporting tool; the done tool stays offered through the agent.
4. **A request asked while no stream is open is not lost.** OpenCode announces each connection; the pending requests are listed then and the done tool's rejected. A stream that ends or breaks is opened again.
5. **The conformance suite counts the requests.** Three scripted steps are three requests on every runtime, a wrap-up turn that calls the done tool is one, and the attempt's text is what the model said before the tool.

## Consequences

- A review of 20 files in 41 tasks with the scripted model: 193 requests instead of 234 and 2,341,750 input tokens instead of 2,910,635 (20% fewer), the same count as the direct runtime. With 300 ms per request it takes 24.5 s instead of 27.5 s. Findings, coverage and the judgement are the same; the report's usage is what the model was sent.
- A model can no longer act after the done tool. On the OpenCode runtime it used to get one more turn, in which it normally said the review was finished; a finding reported there is no longer possible, as on the direct runtime.
- If the event stream is down when a task calls the done tool, the task waits until the stream is back (a second, then OpenCode's client backs off) and, past five minutes without activity, moves to the next model as any silent session does.
- The mechanism leans on how the pinned OpenCode treats a rejected permission. A bump that changes it fails the conformance suite on the request count, not silently.
