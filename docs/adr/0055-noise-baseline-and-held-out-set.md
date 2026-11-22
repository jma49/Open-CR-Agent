# ADR-0055: Noise baseline and the private held-out set

- Status: accepted; amends [ADR-0036](0036-golden-case-set-policy.md) point 3
- Date: 2026-11-22

## Context

`verdict` (eval plan §2) passes a change when the case bootstrap's lower bound stays above `-margin`. The margin is a number someone has to choose, and it means something only next to the noise of the setup it is applied to: with too few repeats or too few claims, an unchanged change is `inconclusive` at any useful margin, and a margin chosen without measuring that is a guess. The plan's measurement phase calls for a separate baseline of repeated smoke runs, an A/A check, the smallest margin the verdict can use, and a registry of baselines, none of which had tooling.

Paid runs wait until the product is polished, so the plumbing has to be checked without spending: what a run would review and the most it could cost.

The held-out tier (ADR-0036 point 1.2) needs changes merged after the reviewers' and the judge's training cutoffs. The freshest such changes with author fixes are in repositories the maintainer owns, which are not under an OSI licence and must not be published. ADR-0036's allowlist refuses them.

## Decision

1. **`ocra-eval noise <run>`** reads one run made with `--repeat k`, k even from 4 to 10, one setup (`compare`'s check). It splits the repeats into two halves every way (a split and its mirror once: 3 splits for 4 runs, 10 for 6, 126 for 10) and judges each split with `verdict`'s own code, as if one half were a change to the other. Nothing changed between them, so:
   - a split called `worse` is a false alarm; **the A/A check passes when there is none** (exit 0, else 1);
   - **the required margin** is the smallest whole number of points above every split's distance from zero to its lower bound: the smallest `--margin` at which an unchanged change passes with k/2 runs a side;
   - it also prints each run's recall, their mean and standard deviation, the median and worst lower bound, and how many splits pass at `--margin`.
2. **The registry** is a JSON list a baseline is added to with `--register <file>`, one entry per run label (registering again replaces it): cases hash, ocra commit, judge, runs, cases, claims, recall mean and standard deviation, required margin and whether the A/A check passed. A baseline with comparison warnings (different judges, unlabelled findings, mixed provenance) is not registered. A gated run compares against a registered baseline scored on the same cases hash.
3. **`ocra-eval run --dry-run`** prints the selection, the number of reviews (PRs × repeats), the spend bound (the per-PR cap times the reviews, under the run's cap; or that there is none), the models from `OCRA_MODEL_*` and the judge, then stops: no review, no judge client, nothing written.
4. **Code the maintainer owns** (amends ADR-0036 point 3) may be a case with `source.licence` `LicenseRef-maintainer-owned`, for the held-out tier only. Those cases live in the maintainers' private repository and run with `--golden-dir`; a test refuses the licence in `evals/golden`, since this repository is public. Everything else in ADR-0036 applies to them: provenance, caps, blind vetting with a second rater on every claim, and nothing from them (ids, claims, model output) appears in public.

## Consequences

- The margin `verdict` uses is measured per setup and recorded, not assumed; a new reference model or judge needs a new baseline.
- The A/A check reuses `verdict`'s bootstrap and sign test, so it checks the gate that is actually applied, including its veto, rather than a separate model of the noise.
- Splits of one baseline are not independent samples, so the false-alarm count is a check, not a rate.
- Cases from the maintainer's own repositories are fresh but come from few codebases and one team's habits; the held-out tier reports them apart from any public-source cases added later.
