# @open-cr-agent/eval

`ocra-eval` replays benchmark changes through the `ocra` CLI and scores the findings. Private, not published. How to run it, the golden case format and the scoring rules are in the manual's [evaluation page](../../docs/manual/en/evaluation.mdx); this file maps the package for contributors.

Run it from a build: `npm run build`, then `node packages/eval/dist/main.js <command>` (`--help` lists the commands).

## Modules

| Module | What it does |
|---|---|
| `cli.ts`, `main.ts` | The usage text and which command runs |
| `commands/*.ts` | One file per command; `options.ts` holds shared flags and selection, `summary.ts` writes a run's summary |
| `repeat.ts`, `interval.ts` | `run --repeat k`: the repetitions, their 95% Student t intervals, and reading a run directory of either kind |
| `provenance.ts` | What the reviews of a run were made with (version, prompt and config hashes, sampling), and the warnings `compare` gives when runs differ in it |
| `instance.ts` | The shared case model: `Instance`, its reference comments, golden expectations and attack |
| `dataset.ts` | Downloads and validates AACR-Bench; turns its rows into `Instance`s, one per pull request |
| `golden.ts` | Loads and validates `evals/golden/*.json` into the same `Instance` shape, with expectations |
| `attack.ts` | Adversarial cases: plants hostile text in the case they attack (ADR-0014) |
| `select.ts` | Which instances a run takes (`--ids`, `--limit`, `--max-change-lines`, tiers) |
| `repos.ts` | Clones and checks out each repository in the cache; `GIT_ENV` keeps LFS and drivers off |
| `reviewer.ts` | Runs the `ocra` CLI on one instance and reads its JSON report |
| `runner.ts` | The run loop: resume, quota detection, one `instances/<id>.json` per result |
| `results.ts` | The schema of an `instances/<id>.json` result, and reading one back to resume or rescore |
| `match.ts`, `judges.ts` | AACR-Bench scoring: matches findings to reference comments by location, then by an LLM judge |
| `score.ts`, `metrics.ts` | Precision, recall and the counts behind them |
| `golden-score.ts`, `attack-score.ts` | Golden and adversarial scoring against expectations and forbidden ranges |
| `adjudicate.ts` | Labels typed into a run's `adjudication.json`, written back into the golden cases |
| `ceiling.ts`, `ceiling-run.ts` | The recall ceiling of the deterministic stages, without a model |
| `golden-import.ts` | `golden-import --from aacr`: unverified case candidates from AACR-Bench pull requests whose in-scope comments the ceiling reaches |
| `compare.ts`, `report.ts` | Side-by-side comparison of runs; the `summary.md` of one run |
| `trend.ts`, `trend-load.ts` | `trend`: golden runs grouped into series by label, compared on shared cases |

## A run on disk

`ocra-eval run --label <name>` writes `.ocra/eval/<name>/` (`--out` changes the parent); a run with an existing label resumes.

| Path | What it holds |
|---|---|
| `run.json` | The run's options and the ids it covers |
| `instances/<id>.json` | One result per instance: status, duration, findings, task outcomes, usage, error |
| `reports/<id>.json` | ocra's own JSON report for the instance; its `runId` names the session below |
| `summary.json`, `summary.md` | Scores, written when the run ends |
| `adjudication.json` | Golden runs: unlabeled findings to label, then `ocra-eval adjudicate <run-dir>` |
| `judge-cache.<model>.json` | Judge answers, so rescoring does not ask again |

A run with `--repeat k` holds `k` such runs in `r1/` … `rk/`, with `repeats.json` (each metric's values and interval) and `summary.md` beside them; the judge cache is shared at the top. `compare` and `score` take either kind of directory.

`run` passes `--temperature` (default 0) and `--seed` (`--model-seed`, default 1) to every review and records them as `info.sampling` in `run.json`; each report's `provenance` goes into `instances/<id>.json`, and `summary.json` lists the distinct values.

Each review's session is in the clone it reviewed, `~/.cache/ocra/aacr-bench/repos/<owner>__<repo>/.ocra/sessions/<runId>/`, with `runId` from `reports/<id>.json`; never match runs to sessions by time.

## AACR-Bench fields

The dataset is cached at `~/.cache/ocra/aacr-bench/` (clones under `repos/`, one per repository, named `<owner>__<repo>`). One row per reference comment; `dataset.ts` groups rows by `pr_url` into instances whose id is `<owner>__<repo>@<first 7 of pr_target_commit>`.

| Field | Meaning |
|---|---|
| `pr_url` | The pull request; the repository is its first two path segments |
| `pr_source_commit` | **The base** of the change, despite its name |
| `pr_target_commit` | **The head** of the change |
| `path`, `side`, `from_line`, `to_line` | Where the reference comment sits (`right` is the new side) |
| `note`, `category`, `label` | The comment, its category, and whether it counts |
| `project_main_language`, `pr_change_line_count` | Used by selection |

## Traps

Maintainers: read the evaluation section of the private `pitfalls.md` before a run (free-quota limits, rebuilding mid-run, LFS repositories, git 2.43, `--retry-failed`).
