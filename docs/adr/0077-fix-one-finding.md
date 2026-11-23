# ADR-0077: A checked fix for one stored finding

- Status: accepted
- Date: 2026-11-23

## Context

Fixes come only from the fix stage of a review with fixes on (ADR-0058). ocra Cloud keeps the findings of earlier reviews, and most have no fix: fixes were off, the finding was over the per-run cap of 10, or the review predates the stage. Offering "fix with ocra" on such a finding today means running the whole review again, paying every reviewer, Verify and the judge for one fix, and hoping the same finding comes back.

ocra Cloud holds a finding in the shape the CLI uploads it (`sharedFindingSchema`): its text, file, lines and quoted code, redacted and cut to the contract's limits. It holds no anchor method or quote signature, and whether the finding was kept with low confidence was not sent.

## Decision

1. **`ocra fix` writes a fix for one named finding** of a pull request, a merge request, a local range or a local commit (`--finding <file|->`, `--head <sha>`, `--json`). Uncommitted changes are refused: a fix names lines of a commit.
2. **The input is the contract's `sharedFindingSchema`**, the shape ocra Cloud already stores; no request shape of its own. It gains an optional `lowConfidence`, which the CLI now uploads, so ocra Cloud can pass it back.
3. **The finding is anchored again at the head, by the review's rules** (`pipeline/fix-finding.ts`): the file is read through `reviewContext`, so a secret's path or `.git/` is refused as for any agent, and the quoted code is matched in the change's hunks as anchoring by `hunk` matches it. The candidate rules are `fixCandidates`'s but one: a fix is asked whether or not the finding has one. A quote that fits one place in the hunks, spans at most 30 lines and is not low confidence is a candidate; anything else answers `not_candidate`. A quote found nowhere is `stale`, unless the stored text was redacted or cut, when the stored code may not be the file's and the answer is `not_candidate`.
4. **One call and the same checks:** the candidate goes through `proposeFixes`, so the fixer role, its prompt (no change, so no evaluation run), the neutralization of the finding's text as data, the spend limit and `checkFix` with the tree-sitter checker are the review's. The command's usage is the call's, reported in the result.
5. **It never writes.** The fix is printed; nothing is committed or pushed, and ocra Cloud commits it as it commits a review's fix.
6. **The result is the contract's `fixResultSchema`**: `fingerprint`, `headSha`, `outcome` (`proposed`, `rejected`, `not_fixable`, `stale`, `head_moved`), `fix` (only when proposed), `reason` (the review's rejections, `FIX_REJECTIONS`, plus `not_candidate`; none for `proposed` and `head_moved`) and `usage`. The contract's `FIX_REJECTIONS` is a copy of core's, held equal by a test, since the contract depends on Zod alone.
7. **Exit codes:** `0` when the command ran, whether or not a fix was kept (the result says why not); `3` when the finding no longer applies to the head (`stale`, `head_moved`), as `ocra generate` exits 3 when the branch moved; `2` for usage, input, configuration and model errors; `130` when interrupted.

## Consequences

- ocra Cloud can offer a fix for any stored finding with one fixer call. It needs the release that ships this command and its contract, and to store and pass back `lowConfidence` for the low-confidence rule to hold for new uploads; findings uploaded before it read as not low confidence.
- `--max-cost-usd` is checked before the one call and charged with it; like every stage, a call in flight is not cut short.
- The finding is re-anchored by its quote, not by its stored lines, so a fix for a head other than the reviewed one is possible when the quote still fits one place; `--head` makes the caller's head explicit.

## Alternatives considered

- **Run a review with `--fixes` limited to the file**: pays every reviewer and the judge, and the finding may not come back the same.
- **Trust the stored lines without re-anchoring**: the stored lines may be from another head, and a fix must apply to the lines it names; the quote is what the review anchors by.
- **A request schema of its own (`fixRequestSchema`)**: would retype the stored finding; the stored shape plus `--head` says everything the command needs.
