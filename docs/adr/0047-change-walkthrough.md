# ADR-0047: A walkthrough of the change, written beside the review

- Status: accepted
- Date: 2026-11-22

## Context

The summary comment says what ocra found, not what the change does. Reviewers open a pull request by reading its diff file by file, in whatever order the platform lists them; a change that spans many files or reroutes calls between components is slow to understand that way. The judge's summary is about the findings and only runs when there are some. A description of the change is model output that ends up rendered on the platform, and it costs a call on every review.

## Decision

1. **A walkthrough is its own stage, run beside the review tasks.** It reads only the plan (the change request and the selected diff), so it adds no latency; it never rejects, and a failed or invalid answer costs the walkthrough with a warning, never the review. It is charged to the spend limit and skipped when the limit is already used up.
2. **One plain completion on a new role, `writer`, at the standard tier.** It is the first agent that writes prose for people rather than checking or grouping, so it gets its own settings (`roles.writer`) instead of borrowing the helper's light tier or the judge's top tier. The prompt holds every selected file's name and size and as much of the patches as fits in 24,000 characters, smallest first, so one large file cannot crowd out the rest; the change itself is data (`prompt-text.ts`).
3. **The model groups and describes; code decides what is true.** The answer is an overview, file groups in reading order and an optional Mermaid sequence diagram. Paths not in the diff are dropped, a file claimed twice stays in its first group, files left out are listed under *Other changes*, and every text has a length cap. A diagram is kept only when every line is a plain sequence-diagram statement on an allowlist (no directive, comment, link, click handler, backtick or angle bracket), with balanced blocks and at most 40 lines; otherwise it is dropped whole.
4. **On by default where people read it.** The library stage is off unless asked (`stages.walkthrough`); the CLI asks for it on `--pr` and `--mr`, and `walkthrough` in the configuration turns it off or on everywhere. It is written again on every review, over the whole selection, so an incremental review still describes the whole change.
5. **Published in the summary comment and the JSON report.** The overview is shown; the groups and the diagram are folded. Everything a model wrote goes through the same neutralization as findings.

## Consequences

- A review of a pull or merge request costs one more standard-tier call, about the size of one file's verification.
- A plugin runtime sees a new `agent` value, `writer`, in completion requests, and account settings may set it.
- The report gains an optional `walkthrough`; ocra Cloud can show it once the upload carries it, a contract change of its own.
- Reusing an earlier walkthrough when the change did not move, and the reply to an `@ocra` mention, are left to their own records.
