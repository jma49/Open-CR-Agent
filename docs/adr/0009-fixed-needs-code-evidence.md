# ADR-0009: A finding is fixed only when its code is gone

- Status: accepted
- Date: 2026-09-26

## Context

Re-review (ADR-0008) matched findings across runs by fingerprint, `hash(category + file + normalized existingCode)`, and called a finding fixed when its fingerprint did not come back while its file was reviewed again. Two of the three inputs came from the model: `category` was an optional free string in `report_finding` that overrode the reviewer's own, and `existingCode` is whatever 1–5 lines the model chose to quote. So a real issue was called fixed, and its thread resolved, whenever the model quoted other lines, used another category, or simply did not report it again. Low recall is normal, so the last case is common. Conversely, a dismissed finding came back as new under a new quote.

## Decision

1. **The category is the reviewer's.** `report_finding` no longer accepts one, and the pipeline always sets the reviewer's `category`. Fingerprints of findings that never had a model-chosen category are unchanged.
2. **"Fixed" needs deterministic evidence:** the code the finding was anchored to no longer exists in the file at the new head, or the file is gone. A finding carries `quote: { lines, hash }`, the count and a truncated SHA-256 of the normalized (trimmed, whitespace-collapsed, blank lines dropped) anchored lines. It is taken from the file's lines at the anchor, not the model's quote, because a partial-line quote never matches a whole line. The GitHub state stores it (optional field in `ocra:state v1`); the source text is not stored.
3. **Presence is checked at the pipeline's edge.** Before reconciling, `priorCodePresence` reads each earlier finding's file at head (through `ReviewContext`, so secret paths stay unreadable) and slides a window of `lines` normalized lines over it. `reconcile` stays pure and receives the result. Unreadable files and findings without a signature (older state, file-level findings) are "cannot tell" and never become fixed; a deleted file is fixed.
4. **Earlier findings that were not reported again, and are neither fixed nor dismissed, stay open:**
   - `notReproduced`: the file was reviewed again and the code is unchanged.
   - `notRechecked`: the file was not reviewed this time (task failed, not assigned, excluded, or no longer in the change).
   Both keep their original severity in the verdict, are listed in the summary, are kept in the state, and get no new comment and no resolved thread. The same code reviewed twice gives the same verdict.
5. Findings reported again but then refuted by Verify or matched by memory are neither fixed nor open; memory entries also remove matching earlier findings. Dismissal rules are unchanged (ADR-0008).

## Consequences

- A thread is resolved only when the code it points at changed. A cosmetic edit of exactly the anchored lines (renaming a variable) counts as a fix; the next run reports the issue again if it persists.
- Findings can stay open longer than before: until the code changes, a reviewer dismisses them, or memory accepts them. That is the intended bias: a wrong "fixed" hides a real issue, a wrong "open" costs a reviewer one click.
- A file that leaves the change keeps its open findings as `notRechecked` rather than calling them fixed, unless the anchored code is gone.
- Moving code to another file still makes the finding new there and fixed in the old file.
- Older state without `quote` is never auto-resolved; since nothing is released yet, no migration is provided.
