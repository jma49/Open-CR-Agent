# ADR-0012: A golden label belongs to one claim about the code

- Status: accepted
- Date: 2026-09-29

## Context

ADR-0011 (point 2) stores each adjudicated label with its case, keyed by the finding's fingerprint: reviewer category, file and normalized quoted code. The fingerprint names the code, not what the finding says about it. Code that draws one claim draws others, so a later finding that quotes the same code but makes a different claim inherited the label (#235).

This was seen in a recorded run. In `cap30-b` (2026-09-28), "Lack of early validation and cleaning for r.Adapters" repeated a claim labeled invalid in three other runs. It quoted the same code as a finding labeled valid, so it was scored as correct: precision 9 of 9 as scored, 8 of 9 by hand. A borrowed label can only raise precision, the number ocra publishes.

## Decision

1. **A label applies to the claim it was recorded for.** It applies to a finding with the same fingerprint and the same title. When the title differs, the evaluation judge, which already decides whether a finding matches an expected issue, is asked whether the finding makes the same claim as the labeled title.
2. **Another claim waits for its own label.** A finding on labeled code whose claim no label covers is unadjudicated: it counts against precision and is written to `adjudication.json` like any unlabeled finding. `adjudicate` records it as a second label for the same fingerprint. Each claim is labeled once, and a case with two labels for one fingerprint and title does not load.
3. **Judge-applied labels are listed.** `summary.md` names every finding that took a label recorded under another title, so a label that no longer fits can be caught.

## Consequences

- A label recorded as valid can no longer turn a wrong claim on the same lines into a correct finding.
- Rescoring stays reproducible: judge answers are cached in the run directory, as for matching. Rescoring a run scored before this change asks the judge once for each reworded claim, a few cents at most.
- Labeling takes a little longer where code draws several claims, since each claim is labeled once rather than each fingerprint.
- The judge can call two claims the same when they are not. Such findings are listed for a look rather than hidden.
- Phrasing that changes between runs is handled by the judge, not by comparing titles literally, which would miss often and ask for more labels.
