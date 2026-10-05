# Golden cases

ocra's own evaluation cases (ADR-0011, `docs/adr/0011-golden-eval-set.md`), one `<id>.json` file each. Files with `tier: "adversarial"` are attacks: they plant hostile text in the case they name (ADR-0014) and run only with `--tier adversarial`. The format is in the user manual's evaluation page; `ocra-eval list --dataset golden` validates every file. Biome skips these files: `ocra-eval adjudicate` rewrites them with `JSON.stringify`, and the schema, not the formatter, checks them.

## Adding a case

From AACR-Bench, `ocra-eval golden-import --from aacr` writes unverified candidates that follow steps 1–3 below (manual, Candidates from AACR-Bench); check and finish them by hand. By hand (the dataset's fields are in `packages/eval/README.md`; note that `pr_source_commit` is the base):

1. Find the pull request in `~/.cache/ocra/aacr-bench/dataset.json` by `pr_url`, or by the first 7 characters of `pr_target_commit` (the instance id is `<owner>__<repo>@<those 7>`). `node packages/eval/dist/main.js list --ids <instance id>` confirms it loads.
2. In the clone (`~/.cache/ocra/aacr-bench/repos/<owner>__<repo>`), set `head` to `pr_target_commit` and `base` to `git merge-base <pr_source_commit> <head>`, as full commit ids. The source commit can be ahead of the merge base, and a case's diff is `base..head`.
3. Write `evals/golden/aacr-<repo>-<short-topic>.json`: `source.kind` `aacr` with the pull request's URL and licence in `ref`, a `rationale`, and `expect`, `forbid` or `clean` checked against the code at `head`, not against the reference comment alone.
4. `node packages/eval/dist/main.js ceiling --dataset golden --ids <case id>` checks that every path is in the change and every expectation is reachable; `list --dataset golden` validates the file.
5. Record the new ceiling: `node packages/eval/dist/main.js ceiling --dataset golden --label ceiling`, then `node scripts/ceiling-gate.mjs .ocra/eval/ceiling/ceiling.json --write` rewrites `evals/ceiling-baseline.json`. CI's `Ceiling` workflow runs the same measurement on every pull request that touches the cases or the deterministic stages and fails when a finding the baseline reaches is no longer reachable.

From ocra's own history or dogfood: the same, with `source.kind` `ocra-history` or `dogfood`, `repo` this repository or the dogfooded one, and the commits of the change in which the issue appeared.

