# ADR-0030: A review task that ends without the done tool leaves its files incomplete

- Status: accepted
- Date: 2026-10-05

## Context

A review attempt that ended without an error counted as finished, whatever it did. The failback yielded `done`, the task's status defaulted to `completed`, and coverage marked every file of the bundle `reviewed`. That included an attempt cut off at the step cap (30 steps) and one that stopped with steps left and no `task_done`. A 10-file bundle whose reviewer read 4 files and ran out of steps was reported as 10 reviewed files with exit code 0. The only trace was the progress line "no task_done" (#477). Users got a wrong report, and the evaluation could not tell a recall miss in a reviewed file from one in a file the reviewer never reached.

ADR-0015 #2 fixed the set of coverage statuses: `reviewed`, `failed`, `unreviewed`, `unchanged`, `excluded`. The maintainer chose to change it (2026-10-05) instead of keeping coverage and exit codes as they were and recording the ending only for analysis.

## Decision

This revises ADR-0015 #2: the set of coverage statuses gains one.

1. **Each attempt has an ending:** `done` (the agent called `task_done`), `step_cap` (it used every step without it), `stopped_early` (it stopped with steps left without it; an agent that stopped silently was first told once to continue), or `error`. Core reads it from what the attempt reports: its error, its tool calls, and whether its last turn used every step it was allowed. Only the runtime can say the last: OpenCode caps each turn, so a resumed session's steps add up past the cap without either turn reaching it.
2. **The ending travels as data.** The `done` event carries `ended: "step_cap" | "stopped_early"` when the task finished without the done tool, and the task outcome and the JSON report's `tasks[]` carry the same `ended`. Absent means `task_done` (or a runtime that does not say), so a third-party runtime and the existing reports stay valid. A failed task already says how it ended in its status.
3. **Such a task's files are `incomplete`**, a new coverage status with `ended`. Like `failed` and `unreviewed`, it makes the file unfinished: the run exits 3, the review state lists it, and the next review of the pull or merge request includes it. Under `--ultra` one sample that called the done tool is still enough. Across reviewers, `failed` outranks `incomplete`, which outranks `unreviewed`, which outranks `reviewed`.
4. **Every surface says what happened and what to do.** The users see "partly reviewed". For `step_cap` the message says that the step limit is fixed and that a smaller change gives each file more steps. For `stopped_early` it says that the reviewer stopped with steps left without saying it had finished, and to run the review again, or to use a stronger model if it keeps stopping. The exit message, the terminal report, the pull or merge request summary (with each file and why) and SARIF all read coverage. The ocra Cloud upload's `complete` follows from coverage, so they agree.
5. **The ending can be extended.** The ending is read as soon as the attempt returns. The wrap-up turn (#470) runs after that, so it can record that a `step_cap` or `stopped_early` attempt was wrapped up, and the findings that turn reported, without changing what the ending says about the files.

## Consequences

- The JSON report stays at version 1: `coverage[].status` gains the value `incomplete` with `ended`, and `tasks[]` gains the optional `ended`. A strict reader that enumerates statuses, such as an older `ocra-eval`, must be updated to read a newer report.
- Runs that hit the step cap now exit 3 where they used to exit 0. In CI, a large bundle that the reviewer cannot finish in 30 steps fails the job, as other incomplete reviews do, until the change is smaller or the next push reviews the rest. This is the intended effect: such a review had been called complete without being complete.
- The evaluation keeps each task's `ended`, so a missed finding can be traced to a task cut off before it got there.
- Rejected: **keeping coverage and the exit code as they were**, with the ending recorded only for analysis. It is cheaper for users in CI, but the report would keep claiming files were reviewed when they were not.
- Rejected: **reporting such files as `failed`.** ADR-0015 keeps `failed` for tasks that started and broke. A reviewer that ran out of steps did not break, and the advice for it is different.
