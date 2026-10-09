# ADR-0031: A retried review reuses the tasks that completed

- Status: accepted
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
