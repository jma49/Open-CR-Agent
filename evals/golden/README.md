# Golden cases

ocra's own evaluation cases (ADR-0011, `docs/adr/0011-golden-eval-set.md`), one `<id>.json` file each, chosen and vetted under ADR-0036 (`docs/adr/0036-golden-case-set-policy.md`). Files with `tier: "adversarial"` are attacks: they plant hostile text in the case they name (ADR-0014) and run only with `--tier adversarial`. The format is in the user manual's evaluation page; `ocra-eval list --dataset golden` validates every file. Biome skips these files: `ocra-eval adjudicate` rewrites them with `JSON.stringify`, and the schema, not the formatter, checks them.

Every case records where it came from: `source.licence` (an SPDX id from the allowlist in `packages/eval/src/golden.ts`; for a choice of licences, the OSI option) and `source.date` (the head commit's date). Every claim in `expect` has an `id` (a short slug, stable within the case: scores, the ceiling and trends pair claims by it), an `origin` (`human-review`, `author-fix`, `ai-reference-vetted`, `model-found-vetted` or `maintainer`), a `producer` (`human`, a model id, or a tool; `<model or tool> (model not recorded)` when a run did not record which model it was) and `optional`. `raters` records who vetted the case, when, and whether blind. A case holds at most 3 required claims, 5 optional ones and 3 `forbid` ranges, and stores only ids, paths, line ranges and ocra's own sentences, never quoted code or comments.

## Vetting protocol

A claim is kept only when all of these hold:

- it is true at `head`, checked against the callers and callees, not against the reference comment alone;
- it is inside what the reviewers are asked to report and names a consequence;
- its range is 15 lines or fewer, with `also` for the other places the same issue is rightly reported (the schema enforces this for required claims);
- its `concern` is one sentence in ocra's own words, and its `minSeverity` is conservative.

Then:

- **Upstream history.** If upstream later fixed the code, the origin is `author-fix`. If upstream kept the behaviour, the claim becomes optional or is dropped.
- **Out-of-contract claims are optional**, and the prompts stay as they are: what the correctness reviewer is told to skip (`packages/core/src/review/reviewers/correctness.ts`), that is anything a linter, formatter or compiler reports reliably, and issues in unchanged code that the change does not make reachable or worse.
- **Claims only a model vouches for are optional** (origin `model-found-vetted` or `ai-reference-vetted`). One becomes required only when a second rater agrees, it is in the diff, its severity is warning or above (the schema refuses it as required at `suggestion`), and runs found it at least twice. A fix ocra's maintainer made because an ocra run reported the issue does not make it `author-fix`. A vetter may also keep a real claim optional until the second rater has seen it; that is how a claim marked for vetting again is kept.
- **Blind vetting.** A vetting agent gets no access to `.ocra/eval` or any run directory. Case files are committed, and so hashed, before any run over them is scored.
- **Second rater.** A blind agent vets again every held-out claim and every open call, and 30% of the others. Below 85% keep/drop agreement, the whole batch is vetted again; disagreements go to the maintainer, who also blind-checks a random sample of kept claims. The case's `raters` records each rater and date.
- **Forbid seeds** come from AACR-Bench comments labelled incorrect (label 0) and from findings the maintainer dismissed.

A claim being vetted again stays in its case with a note in the `rationale`; a claim is retired for a vetting defect, never because runs miss it.

## Adding a case

From AACR-Bench, `ocra-eval golden-import --from aacr` writes unverified candidates that follow steps 1–3 below (manual, Candidates from AACR-Bench), with the licence the repository's root files state at head (`NOASSERTION`, which no case loads with, when they do not name one licence on the allowlist), comments a model wrote, and people's past the first three, as optional claims, and the comments AACR-Bench labels incorrect in `forbid-seeds.json` for `forbid` ranges; check and finish them by hand under the protocol above. By hand (the dataset's fields are in `packages/eval/README.md`; note that `pr_source_commit` is the base, and `is_ai_comment` says whether a person or a model wrote the comment):

1. Find the pull request in `~/.cache/ocra/aacr-bench/dataset.json` by `pr_url`, or by the first 7 characters of `pr_target_commit` (the instance id is `<owner>__<repo>@<those 7>`). `node packages/eval/dist/main.js list --ids <instance id>` confirms it loads.
2. In the clone (`~/.cache/ocra/aacr-bench/repos/<owner>__<repo>`), set `head` to `pr_target_commit` and `base` to `git merge-base <pr_source_commit> <head>`, as full commit ids. The source commit can be ahead of the merge base, and a case's diff is `base..head`. `source.date` is `git log -1 --format=%cs <head>`.
3. Write `evals/golden/aacr-<repo>-<short-topic>.json`: `source.kind` `aacr` with the pull request's URL in `ref`, the licence read from the repository at `head`, a `rationale`, and `expect`, `forbid` or `clean` checked against the code at `head`.
4. `node packages/eval/dist/main.js ceiling --dataset golden --ids <case id>` checks that every path is in the change and every expectation is reachable; `list --dataset golden` validates the file.
5. Record the new ceiling: `node packages/eval/dist/main.js ceiling --dataset golden --label ceiling`, then `node scripts/ceiling-gate.mjs .ocra/eval/ceiling/ceiling.json --write` rewrites `evals/ceiling-baseline.json`, keyed `<case> <claim id>` over required claims. CI's `Ceiling` workflow runs the same measurement on every pull request that touches the cases or the deterministic stages and fails when a claim the baseline reaches is no longer reachable.

From ocra's own history or dogfood: the same, with `source.kind` `ocra-history` or `dogfood`, `repo` this repository or the dogfooded one, and the commits of the change in which the issue appeared. ocra's history makes up at most 30% of the smoke tier's claims and is never held out: the repository and its fix commits are public. From a fresh pull request on GitHub (`github`) or from ReviewBench (`reviewbench`), the same steps apply; ReviewBench's findings are model-written, so their `producer` names the model, its severities are ignored, and its cases are never held out.
