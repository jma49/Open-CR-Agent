# CI

How fast CI must be, and what it may never trade for speed. The same rules hold in ocra-cloud and ocra-site.

## Targets

A pull request gets its result in under 1 minute at the median and under 2 minutes at p95, measured from the run's creation to its last job.

| Stage | Budget |
|---|---|
| Waiting for a runner | 5 s |
| Setup (checkout, Node, dependencies) | 15 s |
| Slowest job | 35 s |
| A test file | 20 s (split it beyond) |

## Rules that outrank speed

- **The full suite runs before anything reaches `main`.** A pull request may run less only once a merge queue runs everything; until then every pull request runs every check.
- **Never hide a failure.** No retries, wider timeouts or skipped tests. A check that needs a retry has a bug: find it.
- **Never check less.** Lint rules and required checks only stay or grow.

## Budgets in CI

`.github/ci-budgets.json` holds each job's ceiling for setup and for running, in seconds; the `budget` job, last in `ci.yml`, reads the run's jobs (`scripts/ci-budget.mjs`) and fails when one went over. Waiting is reported, not judged: it depends on the runners, not the repository.

The ceilings start just above the p99 of the last 150 runs, so a run fails on a real slowdown rather than on an ordinary slow runner, and they only go down: a pull request that makes CI faster lowers them to its new numbers, so the gain is kept. A ceiling is raised only with a measured reason in the pull request, never to make a slow run pass.

## Changing CI

- One small pull request per change, with before and after numbers from real runs.
- Before switching a tool, run the old and the new side by side and list anything the new one misses.
- Anything that needs an account, a secret or a bigger bill goes to the maintainer first, with its monthly cost.
