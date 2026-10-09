# ADR-0032: Verification decides what blocks, and an unchecked critical finding makes the review incomplete

- Status: accepted (records decisions made on 2026-09-26 and 2026-09-27)
- Date: 2026-10-09

## Context

ADR-0004 and ADR-0018 say the verdict is computed by code, not by a model. They do not say how verification enters it, and that is the part CI depends on. A single critical finding is one model's claim about a change that may have been written to provoke it; letting it fail a pull request makes a hallucination, or a planted instruction, a merge blocker. Ignoring critical findings Verify could not check is worse the other way: a run whose Verify failed, timed out or ran out of budget exited 0 and read as a pass.

## Decision

1. **Only a confirmed critical finding blocks.** The verdict is `significant_concerns` (exit code 1) only when Verify confirmed a critical finding. A critical finding Verify judged `uncertain` or left `unchecked` caps the verdict at `minor_issues`. The judge can neither drop nor downgrade a confirmed critical finding.
2. **A critical finding Verify could not check makes the review incomplete.** When Verify failed, timed out or ran out of budget on a critical finding that counts toward the verdict, the run exits 3, as it does for an unfinished file (ADR-0030). Low-confidence findings under `--ultra` do not count, and `verify: false` turns the rule off with Verify itself.
3. **Incomplete outranks blocking.** The exit code checks completeness before the verdict, so a run that is both incomplete and blocking exits 3. The Action lets exit 1 pass unless `fail-on-concerns` is set, but never exit 3: a review that missed files or could not check a critical finding must never read as a pass.
4. **The verdict stays advice.** `fail-on-concerns` is off by default, and every surface shows each finding's verification and says the verdict is not a security gate.

## Consequences

- A hallucinated or injected critical finding costs a warning and a verification call, not a red CI run; a real one blocks only once Verify confirms it against the code.
- A cheap or flaky verifier model shows up as incomplete runs (exit 3) rather than as silent passes. The cost is CI noise when Verify is unreliable; `verify: false` is the explicit opt-out.
- Exit codes 1 and 3 are a contract (the manual's exit code table); changing which wins, or what counts as unchecked, is a breaking change for every CI job that reads them.

## Alternatives considered

- **Block on every critical finding.** Simplest, and what ocra did before 2026-09-26; one model's unchecked claim then fails CI.
- **Treat an unchecked critical finding as a pass.** What ocra did until 2026-09-27; a run that could not check its blockers exited 0.
