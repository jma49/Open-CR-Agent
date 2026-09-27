# ADR-0010: Incremental re-review of pull requests

- Status: accepted
- Date: 2026-09-26

## Context

Every push to a pull request reviewed the whole pull request again and reconciled findings by fingerprint (ADR-0008, ADR-0009). Cost grew linearly with the number of pushes, although most pushes touch a few files. The GitHub state did not record which commit the previous review covered, so there was nothing to compare against.

## Decision

1. **The state records the reviewed head and the unfinished files.** `ocra:state v1` gains two optional fields: `head` (the commit reviewed) and `pending` (files whose review failed or that no reviewer covered). If `pending` would exceed its bound, `head` is left out, so the next run reviews everything rather than skipping a file.
2. **`PriorReview` says what changed; the `VcsAdapter` interface does not change.** `PriorReview` (returned by `getPriorReview`) gains two optional fields:
   - `changedSince: { head, files }`: files changed between the earlier head and the current one, plus the pending files.
   - `fullReviewReason`: why everything is reviewed again.

   An adapter that sets neither gets a full review, so `vcs-local` is untouched.
3. **The GitHub adapter asks its history source.** `GitHubAdapterOptions.history.filesChangedSince(from, to)`, which the CLI answers from the local clone (`filesChangedSince` in `vcs-local`, a plain function, no new adapter abstraction). If the earlier head is not an ancestor of the new head (force-push, rebase) or is not available, the answer is a reason and the review is full.
4. **Only a state ocra last edited is trusted for scope.** Anyone with write access, including a pull request's author, can edit the summary comment. A forged `head` could skip their next changes. The adapter asks GraphQL for the comment's last editor. If someone other than ocra edited it, or the check fails, the review is full.
5. **The pipeline reviews only those files.** `planReview` bundles only selected files in `changedSince.files`. The whole change still sets the risk tier. The other selected files get coverage status `unchanged`, and their earlier findings carry over as `rereview.unchanged`: open, counted in the verdict with their own severity and verification (ADR-0009, verdict rules), and without new comments.
6. **`--full`** (with `--pr`) forces a full review. The report's `scope` says whether a run was incremental (and since which commit) or full (and why), and the summary comment shows it.

## Consequences

- Cost per push follows the size of the push, not of the pull request.
- An issue that spans an unchanged file and a changed one is seen only from the changed side. `--full`, or any force-push, re-reviews everything.
- Configuration, rules or memory changes on the base branch do not trigger a re-review of unchanged files; `--full` does.
- One extra GraphQL call per run (the comment's editor). When it fails the run is simply full.
- `report.json` coverage has a new status value, `unchanged`, and a new optional `scope` field.

## Implementation notes (2026-09-27)

- The state records the tier each review ran at. When a push raises the tier (for example from `trivial` to `full`), the review is full, because the higher tier adds reviewers the unchanged files never had; `scope.reason` says so. A state without a tier (written before this) keeps the incremental behaviour.
- The state is trusted only when ocra last edited the summary, for all of its fields, not only `head`; dismissals are recomputed from threads and never stored (#105). A `posted` field remembers inline comments on findings that are no longer tracked (#114).
