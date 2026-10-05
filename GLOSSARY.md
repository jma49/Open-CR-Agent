# Open-CR-Agent

The language of a code review run: what is reviewed, by whom, and how far each review got.

## Language

**Review task**:
One reviewer's review of one bundle of files, run as an agent with read-only tools.
_Avoid_: Job, cell (those name the plan's slot, not the run)

**Attempt**:
One run of a review task on one model of its chain; a task makes another attempt on the next model when one fails.
_Avoid_: Try, retry

**Ending**:
How an attempt ended: `done` (its agent called the done tool), `step_cap` (it used every step without it), `stopped_early` (it stopped with steps left, without it) or `error`.
_Avoid_: Finish reason, exit reason

**Coverage status**:
What the run did for one changed file: `reviewed`, `incomplete`, `failed`, `unreviewed`, `unchanged` or `excluded`.

**Incomplete (file)**:
A file one of whose reviewers' tasks ended without the done tool, so it was at most partly reviewed; shown to users as "partly reviewed".
_Avoid_: Cut off, truncated

**Unfinished file**:
A selected file the run did not finish (`failed`, `unreviewed` or `incomplete`): it makes the run incomplete (exit code 3) and the next review of the change includes it.
_Avoid_: Pending file, missed file
