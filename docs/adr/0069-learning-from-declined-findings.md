# ADR-0069: Learnings from the findings a pull request's reviewers declined

- Status: accepted
- Date: 2026-11-23

## Context

ADR-0040 made review feedback a learning source: what maintainers dismissed or accepted, and why. `ocra learn feedback` reads only `.ocra/memory.json`, which a person fills with `ocra memory add` on their own machine. On a pull request the same decision is made in the thread of ocra's comment: someone answers "won't fix: the gateway validates this" or resolves the thread after saying why. That reason was read by the next review of the same pull request (ADR-0016) and then lost.

The review counts a dismissal only from someone with write access other than the author, because a dismissed finding leaves the verdict. A learning is different: it changes nothing until a pull request adds its file, and `/ocra remember` (ADR-0040) already takes the author's word on those terms.

## Decision

1. **`ChangeRequest.declined` lists the declined findings of the earlier review:** for each thread of ocra's whose finding the trusted review state names, the words of someone with write access, in a reply nobody else edited: their latest reply that declines the finding (`/ocra dismiss`, "won't fix", "by design"), or their last reply when someone with write access resolved the thread. The author counts, the bot never does.
2. **`ocra learn feedback --pr <n>` or `--mr <iid>` drafts from them,** after `.ocra/memory.json`'s entries and without those it already holds, as accepted findings: the finding's title, the reason, and the file as the change has it, else as the trusted revision does. The source is `{ kind: review-feedback, ref: <fingerprint> }`, so a finding already recorded or proposed is not drafted again.
3. **The drafter skips a reason that says the finding was or will be fixed:** a thread resolved after "fixed in abc123" holds no lesson.
4. **Nothing else changes:** deduplication, replay, the limits and write-back by pull request are ADR-0040's.

## Consequences

- A service that hosts reviews can run this command when a thread is answered or resolved, and a declined finding becomes a proposed learning without anyone running a command.
- A pull request's author can have a "do not report this here" learning proposed; a team that does not want that merged unseen sets `learnings.requireReview`.
- A thread resolved with no reply gives no reason and so no learning.
- Reading the threads costs a re-review nothing new; a first review reads none.
