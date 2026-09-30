# ADR-0015: Under a spend limit, finish files in plan order, and say what the limit left

- Status: accepted
- Date: 2026-09-30

## Context

A review with `--max-cost-usd` stops its review tasks when their share of the limit (80%) is spent: tasks not yet started never start, and running ones stop (#259). Dogfood reviews run with a $2 limit. On a jmos pull request with 14 files and 28 tasks the limit held ($1.69), but most files went unreviewed. Two questions followed.

1. **Should the tasks run in another order?** They run in plan order: bundle by bundle, every reviewer of a bundle before the next bundle. The task limit (`maxTasks`) already cuts in another order, breadth first: `--ultra`'s second samples first, then reviewers in reverse registration order, so every file keeps its first reviewer as long as possible. Running in that order under a spend limit too would give every file its correctness review before any file gets its security review.
2. **Does the report say what happened?** A task the limit never started made its files `failed`, the same as a task that crashed, and nothing in the pull request summary named the limit.

The order question turns on how a pull request's next review continues. The review state in the summary comment records the head it reviewed and the files it did not finish (ADR-0010). A file counts as reviewed only when every reviewer assigned to it finished, and unfinished files are recorded per file, not per reviewer. The next review reviews the changed and unfinished files, with all their reviewers, in the same deterministic order.

- **Breadth first under a spend limit:** the first run gives correctness to the first K bundles and leaves nearly every file unfinished, because each still lacks a reviewer. The next push, under the same limit, runs correctness on the same K bundles again. The later reviewers never run, and files past K never get reviewed. Nothing progresses, and money goes to work already done.
- **Plan order:** the first run finishes the first K bundles, and the rest stay unfinished. The next run starts on the rest. A large pull request is covered over a few pushes, which is what a $2 limit per push can do.

## Decision

1. **Under a spend limit, tasks keep running in plan order.** The task limit keeps its breadth-first cut. A change with more cells than the limit exceeds it on every run, so it cannot progress across runs anyway, and there breadth serves best. With four tasks running at once, order decides which tasks start, not which finish.
2. **A task that never started leaves its files `unreviewed`, not `failed`**, whether the spend limit or a cancelled run kept it from starting. `failed` stays for tasks that started and did not finish, including those the limit stopped while running. The set of coverage statuses is unchanged, and both statuses still make the run incomplete (exit code 3) and put the file in the next review.
3. **The run says what the limit did:**
   - a warning like the task limit's: `spend limit of $2 reached: N review task(s) did not start; their files are reported as not reviewed`;
   - a new optional report field, `spendLimit: { usd, reached? }`:
     - `reached: "review"` when the review share ran out, so review tasks stopped;
     - `"total"` when the whole limit ran out, so verification, judging or relocation may have been skipped.

     Adding an optional field keeps the JSON report at version 1.
4. **The pull request summary names what is missing:** `**Incomplete:** N selected file(s) were not reviewed; the spend limit of $2 was reached`, and that the next review includes them. It shows the limit in its cost line. The terminal output does the same.
5. **A state too large for the summary comment warns.** Such a state drops its head and unfinished files, so the next review starts over; the review now says so, since progress across pushes depends on that list.

## Consequences

- Without a spend limit, nothing changes: the same tasks run in the same order with the same prompts. This is reporting, not a change to what models see, so it merges without an evaluation run.
- Under a spend limit, a single run still reviews only a prefix of the change. A local `ocra review` with a small limit covers fewer files than breadth first would. The report says which files it missed.
- `unreviewed` now covers files no reviewer covers, files past the task limit, and files whose tasks the spend limit or a cancelled run never started. The terminal calls them "not started".
- **Rejected: breadth first under the spend limit**, security first or correctness first. It would need unfinished work recorded per reviewer and file, and the matrix narrowed to the reviewers a file still lacks. That is a change to the state format and the planner, and the future path if single runs under small limits matter more than progress across pushes. Reviewer registration order stays the priority for the task limit, which is the user's lever: a team that wants security first can register reviewers in that order.
- **Rejected: running larger bundles first.** No measurement favors it, and it spends the limit on fewer files. Plan order is deterministic and matches `--plan`, so users can predict what runs first.
