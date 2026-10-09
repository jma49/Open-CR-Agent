# ADR-0011: Quality decisions on an ocra-owned golden set; AACR-Bench stays the external number

- Status: accepted; point 2 amended by [ADR-0012](0012-golden-labels-per-claim.md) (a label belongs to one claim)
- Date: 2026-09-27

## Context

`ocra-eval` replays one dataset, AACR-Bench (Alibaba, downloaded from Hugging Face on first use). Its precision is semantic matches divided by reported findings (`metrics.ts`), and its references are the comments human reviewers happened to leave. A real issue nobody commented on therefore counts against ocra, so AACR-Bench understates precision, the metric ADR-0004 optimizes. 40.0% of its issues are maintainability and readability, which ocra does not report by design; that caps recall at 57.7% (`ocra-eval ceiling`). Its comments labeled incorrect are meant for evaluating comment filters and are not used (`dataset.ts`), so nothing marks a place where a finding would be wrong. Its content, format and availability are outside our control.

Ten pull requests wait for an eval (#85, #86, #103, #126, #142–#146, #150; the maintainers' private notes), and the model budget is finite. Deciding them needs a small, fixed, repeatable set on which one run can tell a regression from noise.

## Decision

AACR-Bench stays, unchanged, as the number comparable with published results. Merge decisions for `[needs-eval]` pull requests and prompt, rule or stage changes are made on a golden set that ocra owns.

1. **Cases live in the repository**, one file per case under `evals/golden/`, validated with Zod at load. A case pins a public repository at a base and a head commit, says where it came from and why it was taken, and lists:
   - `expect`: findings ocra must report (file, line range, category, lowest acceptable severity, the concern in one sentence);
   - `forbid`: ranges where a finding is wrong, each with the reason, or `clean: true` for a change with no issue at all.
   A case loads into the existing `Instance` and the clone cache; `ocra-eval --dataset golden|aacr` picks the source.
2. **Adjudication is recorded once, not re-judged per run.** A reported finding that matches no `expect` entry is labeled by the maintainer as valid or invalid, and the label is stored with the case, keyed by the finding's fingerprint (category, file, normalized quoted code). A valid one becomes an `expect` entry. Precision counts matched and adjudicated-valid findings over all reported findings; findings not yet adjudicated are reported as a count, never guessed. A fingerprint changes when the model quotes different code, so the same issue can come back for one more label.
3. **Scoring names what costs trust.** A critical finding inside a `forbid` range or on a clean case is a failure, listed by case and finding. Recall is measured on `expect`; cost and latency as today.
4. **Two tiers.** `smoke` (5–10 cases) runs before and after every `[needs-eval]` change, once each; `full` (20–30 cases to start) runs before a release. The smoke baseline is run twice once to measure run-to-run spread, and a change smaller than that spread is reported as no change.
5. **Sources, most trusted first:** bugs fixed in ocra's own history (review the commit that introduced the bug; the fix is the answer); findings the maintainer confirmed or dismissed in real use (dismissals become `forbid`); AACR-Bench pull requests in correctness, security and performance, after checking each reference (its comments labeled incorrect can seed `forbid`). Prefer commits made after the models' training cutoff, and repositories whose license allows redistributing the excerpts a case quotes.
6. **Until the smoke tier exists**, a `[needs-eval]` change that needs a model run is compared before and after on the same small AACR-Bench subset, with the baseline run twice for the spread. AACR-Bench's bias against precision is the same on both sides of such a comparison, so the difference is usable even though the absolute numbers are not. Changes that free evidence already decides (`ocra-eval ceiling`, `--plan`) need no model run.

## Consequences

- Precision becomes measurable, and the set grows from use rather than from a one-off labeling effort. The cost is the maintainer's labeling time, bounded by labeling each fingerprint once.
- A small set cannot show small effects; the spread rule says so instead of reporting noise as progress.
- The seed is the #12 baseline on AACR-Bench: its unmatched findings are the first to adjudicate.
- `--dataset` and the case format are external contracts: the manual documents them in both languages when they ship.
