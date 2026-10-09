# ADR-0031: A retried review reuses the tasks that completed

- Status: accepted; points 1, 4 and 5 amended on 2026-10-09 ([below](#amendment-2026-10-09-resume-only-what-this-machine-sealed))
- Date: 2026-10-08

## Context

A review is many tasks, one per (bundle, reviewer). When a provider refuses some of them for quota (a 429 that outlasts the backoff, #500), the run completes with those tasks failed and exits 3. The only way to finish it was to review the whole change again, paying a second time for the tasks that had completed. `ocra-eval run --retry-failed` did exactly that for every PR that lost a task to the quota. On the 2026-10-08 Vertex round, $13 of $64 of review spend (20%) went to tasks reviewed again after they had already completed; one case was reviewed three times (#501). A 429 costs nothing; the waste was the rerun.

Core had no notion of an earlier run's tasks. The incremental re-review of a pull request (ADR-0016) works per file, from the platform's state, and reviews a pending file again with every reviewer. Task ids name a position in the matrix, not its inputs, and model grouping can bundle the same files differently on the next run.

## Decision

1. **A completed task records what it answered, under the key of its inputs.** After a task completes (not one cut off before it finished, ADR-0030, which is reviewed again), core emits `task_reported` with the task id, the findings as the task reported them (before anchoring, in the shape the runtime boundary already validates), and a key: the hash of its review prompt (instructions, change, bundle, rules, guidelines, memory), its model tier, chain and effort, `--ultra`, and the caller's ocra version and sampling. The session log keeps it, so a run that was killed still has it.
2. **`ReviewOptions.resume` takes an earlier run** (`ResumedRun`: its id, bundles and completed tasks). A cell whose key matches an unused earlier task is not run: the earlier findings are anchored again against this change (same commits, so they land where they did) and the outcome carries `reusedFrom`, the run that paid for it. An `--ultra` cell's two samples take one earlier sample each. Anything that would change a task's answer changes its key, so the task runs: reuse needs no separate check of commits or configuration.
3. **The earlier bundles are kept** (from `files_bundled`'s `groups`, so a killed run has them too) when they hold exactly the files in scope, so the grouping call is skipped and its variance cannot reshuffle the tasks.
4. **Spend is honest.** A reused task costs this run nothing: the run's `usage` and its spend limit count only what it paid; the task's own `usage` stays what the earlier run paid, marked by `reusedFrom`. A warning counts the earlier completed tasks that could not be reused.
5. **`ocra review --resume <run-id>`** reads the run from `.ocra/sessions/<run-id>`, validating every line and applying the bounds live findings get (the session lives in the reviewed tree, so a planted one can bring in no more than a model could), refusing a linked session directory; **`ocra-eval run --retry-failed`** resumes the earlier attempt when its session is still in the clone, appends the new session log to the old one for the recall funnel, and records the PR's usage as both attempts' when any task was reused.

## Consequences

- Retrying after a partial quota failure costs only the failed tasks (plus Verify and the judge, which run on the whole result again).
- The session log grows by one event per completed task, holding its findings once more before anchoring.
- The JSON report stays at version 1: `tasks[]` gains the optional `reusedFrom`.
- A reused task's tool calls are in the earlier session, not the new one; eval concatenates the two for the funnel.
- Rejected: **keying on the task id and the run's provenance.** Task ids follow bundle order, which grouping can change, and provenance omits the change, memory and guidelines; the prompt hash covers all of them.
- Rejected: **storing anchored findings.** They have no validating schema at the boundary, and anchoring again is deterministic for the same commits.
- Rejected: **retrying only inside the run** (longer backoff). It helps (#500), but a daily or shared quota can stay spent for hours, and a killed run would still lose its work.

## Amendment, 2026-10-09: resume only what this machine sealed

### Context

The 2026-10-09 audit (E8, #511) found that point 5's defenses (every line validated, findings bounded, a linked session directory refused) do not stop a session that arrives with the change. `.ocra/sessions/` is in the reviewed tree; a task key hashes inputs an author can compute; the run id is printed in the summary comment. A committed session could therefore hand a resumed run completed tasks that found nothing, and turn a review that did not look into a pass. The log was also opened through links and buffered whole, so a link to a device stalled the CLI. The same audit (E25, #517) found that the key left out the commits, so a rebase that kept the hunks byte for byte reused findings made against other surrounding code, and that the spend limit was checked before reuse, so free reused tasks were skipped as "spend limit reached" when resuming a run that had hit `--max-cost-usd`. It also found (E31, #517) that eval, by appending the new session log to the old one, fed the recall funnel every event of the attempt resumed, even when nothing was reused: what the lost tasks read and raised, and that attempt's Verify and judge.

### Decision

1. **Sessions are sealed with a key of this machine's user.** Each line of `events.jsonl` ends with a `seal` field: HMAC-SHA256 over the run id and the line, keyed by a 32-byte secret that the CLI makes on first use in the user's ocra directory (`~/.config/ocra/session-key`, mode 0600), never in a repository. `session-jsonl` takes it as its optional `sealKey` setting. `--resume` reads only lines whose seal verifies for the run id it names: other lines are skipped and counted in a warning, and a session with no such line is refused. The bundles come from the sealed `files_bundled` event; `report.json`, which carries no seal, is no longer read.
2. **The log is read as a regular file, without links, within a bound.** A link at the session's directories or at `events.jsonl` is refused (`O_NOFOLLOW`), anything but a regular file is refused, and the read stops at 64 MiB counted as read, not taken from `stat`. `readReport` reads within the same bound but follows links, since a report the user names may be one.
3. **Sealed lines are still checked**: validated, bounded like a model's answer, and `reusedFrom` must be a run id.
4. **The key includes the base and head commits.** A reviewer reads code around the change that the prompt does not hold.
5. **A reusable cell is reused before the spend limit is checked.** It costs nothing.
6. **eval keeps only the reused tasks' earlier events.** Instead of appending the new session log to the old one, `ocra-eval run --retry-failed` writes the events of the tasks the new review reused, taken from the earlier attempts and matched by their key within each attempt, then the new log.

### Consequences

- A session resumes only on the machine and user account that wrote it. Deleting the key makes earlier sessions impossible to resume, nothing else. A CI job makes a new key, so it cannot resume another job's session.
- Sessions written before this amendment carry no seal and cannot be resumed (`--resume` had not been released).
- Each line grows by 74 bytes.
- Rejected: **moving resumable state out of the tree** into a per-user state directory. Sessions stay where `ocra metrics`, `ocra memory`, eval and the Action find them; a second store would need a lifecycle of its own, and the seal gives the same trust in one file.
- Rejected: **refusing `--resume` with `--pr` or `--mr`.** A forged session is the same threat in every mode, and retrying a pull request's review locally is a real use.
- Rejected: **refusing a session git tracks.** It checks how the files arrived, not who wrote them: a checkout may replace ignored files, and files can arrive by other ways than git.
