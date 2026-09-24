# Evaluation

`@open-cr-agent/eval` (`ocra-eval`) replays [AACR-Bench](https://github.com/alibaba/aacr-bench): 200 real pull requests from 50 open-source projects in 10 languages, with 1,505 expert-verified review comments as ground truth.

## Running

```bash
npm run build
export GEMINI_API_KEY=...                          # reviewer models and default judge
export OCRA_MODEL_STANDARD=google/gemini-flash-lite-latest

node packages/eval/dist/main.js list --limit 20 --max-change-lines 300          # free preview
node packages/eval/dist/main.js run  --limit 20 --max-change-lines 300 --label baseline --max-cost-usd 5
node packages/eval/dist/main.js score .ocra/eval/baseline                        # re-score only
```

- **Selection** is seeded (`--seed`, default 1), so a subset can be rerun on exactly the same PRs. Filters: `--limit`, `--languages`, `--max-change-lines`, `--ids`.
- **Runs resume.** Each PR's result is saved under `<run>/instances/`; rerunning the same `--label` skips finished PRs.
- **Spend cap.** `--max-cost-usd` stops starting new PRs once review spend reaches the cap; skipped PRs are reported, never scored.
- **Repositories** are cached as blobless clones under `~/.cache/ocra/aacr-bench/repos`. PRs whose commits were force-pushed away and can no longer be fetched are marked `unavailable` and excluded from scoring, separately from review failures.
- Each PR is reviewed by running the real `ocra review --from <base> --to <head> --format json`, as the official adapters do for other reviewers.

## Matching and metrics

A port of AACR-Bench's `evaluate_comments`, so numbers are comparable with published results:

1. same file path, 2. same diff side, 3. line ranges overlap or are at most one line apart (skipped when either side has no range), 4. an LLM judge decides whether both comments express the same concern. Each generated comment counts at most once.

| Metric | Definition |
|---|---|
| Precision | semantic matches / generated comments |
| Recall | semantic matches / annotated comments |
| F1 | harmonic mean of the two |
| Line precision / recall | the same with line matches only |

Counts are summed over all reviewed PRs. Failed PRs are excluded from quality metrics and reported separately. The summary also breaks results down by language, issue category and context level, and reports tokens, cost and latency.

**Judge.** Any OpenAI-compatible endpoint via `JUDGE_BASE_URL`, `JUDGE_API_KEY`, `JUDGE_MODEL` (the official variable names); otherwise a Gemini key through Google's OpenAI-compatible endpoint with `gemini-flash-lite-latest`. The official judge prompt is used at temperature 0 for reproducibility. One deliberate fix: the official parser treats "No, they are not the same issue" as a match because it contains "same"; an answer opening with "no" is a no here. Judge answers are cached per run, so re-scoring is free. `--mock-judge` uses word overlap for offline pipeline checks; its numbers are not comparable.
