# ADR-0081: Every review keeps its trace, and ocra Cloud shows it

- Status: accepted
- Date: 2026-11-24

## Context

A person reading ocra's verdict on a pull request has to take it on trust: the report says what was found, not how. They cannot see which files each reviewer opened, which model answered, how long each step took, what it cost, or why a finding a reviewer reported never reached the comment. The session log (`events.jsonl`) holds most of the facts, one event per line, but nobody reads it, it does not time the plain model calls (plan, grouping, walkthrough, Verify, Judge, relocation) or say which model answered them, and it holds code and answer text, so it cannot be handed over.

Teams adopting ocra inside a company ask for exactly this: evidence a human reviewer can check before trusting a blocking verdict, and a way to see where a slow or costly review spent its time.

## Decision

1. **The run builds its trace from its own events.** `reviewWithHooks` feeds every event it emits to a `TraceRecorder` and puts `recorder.build(report)` on the report as `trace`. The trace has, in milliseconds from the run's start: each stage's start and length; each task with its reviewer, bundle, files, status, spend and attempts; each plain model call; and each reported finding's fate. Nothing else in the pipeline changes, and a caller of the library gets it for free.

2. **Attempts and calls are timed where they run.** `withFailback` times each task attempt and records its steps, calls per tool, ending and spend in its `AttemptRecord` (beside the files it read, which it already kept). Plain completions are timed by wrapping the runtime (`tracedRuntime`), which emits a `model_called` event per call with its agent, the model that answered (`CompletionResult.model`, set by `completeWithFailback`), time and spend, failed calls included. No stage reports its own calls.

3. **A finding's fate comes from the events that decided it.** Kept (in the report, with any recalibration), `outside_review` (`finding_dropped`), `refuted` (Verify's reason), `merged` (into which finding) or `dropped` (the judge's reason), else `filtered` (memory, an earlier dismissal, the pre-existing switch).

4. **The trace holds no code or text a model wrote at length.** Paths, counts, models, times, spend, finding titles and the verifier's and judge's one-line reasons; the number of searches, never the searched literals; never a prompt, an answer or a quoted line. That is what makes it shareable.

5. **Locally it is `trace.json`; to ocra Cloud it goes with the findings.** The session writer writes it beside `report.json`. The upload carries it as `trace` only when the account shares findings, since it names files and findings like they do; titles, reasons and paths go through the findings' redaction, and every list is bounded by the contract (`MAX_TRACE_*`); a trace too large first loses what each attempt read, then is not sent. ocra Cloud reads one that does not fit as absent and keeps the rest of the upload.

## Consequences

- ocra Cloud can draw a review as a timeline (stages, tasks, attempts, calls) and a funnel of its findings, and offer the trace as a download for a reviewer.
- The session log grows by one event per plain call and a few fields per attempt; the report object by the trace. The JSON report is unchanged.
- Per-step spans inside an attempt (each model turn and its tool calls) are not recorded: an attempt is the unit. A runtime that reports its turns could add them later without changing the shape.
- A third-party runtime that does not say which model answered leaves `model` out of its calls; its tasks are timed all the same.
