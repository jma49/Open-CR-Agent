# ADR-0054: Pre-merge checks in plain words, judged beside the review

- Status: accepted
- Date: 2026-11-22

## Context

Teams write rules for a change that no pattern can test: "the description says how users are affected", "a new migration comes with a test". ocra Cloud stores such rules per repository and posts the outcome on the pull request as one check, but it has no model and no checkout; the review that already reads the change does. The same rules are useful without ocra Cloud, in a repository's own configuration. ocra Cloud also counts how often each learning applies, which needs the review to say which it gave its tasks, and copies the prefix of the learnings proposal branches.

## Decision

1. **Checks are configuration.** `mergeChecks` lists `{ id, instruction }` entries (at most 20, instructions at most 500 characters, ids unique), from the repository's file, `--config` or a shared configuration, never the account. The shape is the contract's (`mergeCheckSchema`), since ocra Cloud writes it into the configuration of a hosted review (ADR-0046). The id names the check's current text: ocra Cloud makes a new one when the instruction changes, so an outcome never answers an older rule.
2. **One top-tier call on the `judge` role, beside the review tasks.** Like the walkthrough (ADR-0047) it reads only the plan: the change request, every selected file's name and as much of the patches as fits in 40,000 characters, smallest first, with each instruction in its own tag. It adds no latency and never rejects. Judging a rule needs the judge's care, so it borrows that role's settings rather than adding one.
3. **Three outcomes, decided against the configuration.** `passed` (met or not applicable), `failed`, `inconclusive` (what the call was shown cannot settle it), each with a reason of one sentence, cut at 300 characters. An outcome for an unknown id is dropped, the first one for an id wins, and a check left out is inconclusive. A failed call, an invalid answer or a spent limit leaves every check inconclusive with a warning.
4. **Outcomes inform; they do not gate.** They go into the summary comment and the report's `mergeChecks`, and never change the verdict or the exit code: whether a failed check blocks is the reader's to decide, as ocra Cloud does per check (off, a warning, blocking).
5. **The upload carries outcomes and learning ids.** With a pull or merge request, each check's id and outcome, its reason only with the findings (redacted the same way); the ids of the learnings the tasks were given, also with a local review that shares findings, and an empty list when none applied, so absent means an older client. The contract exports the proposal branch prefix, `LEARNING_PROPOSAL_BRANCH`.

## Consequences

- A review with checks costs one more top-tier call. The prompts of the walkthrough, the mention reply and the checks share one rendering of the changed files (`review/change-text.ts`).
- A plugin runtime sees `judge` calls that are not the judge stage; account settings for the judge apply to both.
- Checks that need the whole repository, the review's findings or the linked tasks are left out: the call sees the diff and the change request only.
