# ADR-0029: Committable suggestions, plumbing first

- Status: accepted
- Date: 2026-10-04

## Context

The roadmap's "Review experience" item 2 asks that a finding whose fix is a local edit be offered in the platform's suggestion format, so a reviewer applies it with one click: GitHub's ```` ```suggestion ```` block, which replaces the lines the comment spans, and GitLab's ```` ```suggestion:-N+M ````, which replaces N lines above to M lines below the commented line.

A suggestion that is wrong is worse than none: one click commits it. And prompts, rules and reviewers are frozen until M11's evaluation, so the fix has to come from what reviewers already report. Today that is `suggestion`, free text the prompts describe as "an optional minimal fix", and `existingCode`, the quote the anchor stage turns into lines. Nothing in it says which lines a code block in the suggestion replaces.

We measured whether a deterministic rule could tell. Across the reports saved by our evaluation runs (110 distinct suggestions), 53 contain a fenced code block and 39 exactly one. Those blocks are rarely a replacement of the quoted lines: most rewrite a whole function around a one-line quote, change another file (the declaration in a header, the caller, a new helper), show only the added lines, or elide with `...`. The strictest rule we could defend (exactly one block, no elision, and its first and last non-blank lines equal to the quote's, so the block plainly spans the quoted lines) matched 1 of the 110. One hit cannot show the rule is safe, and nothing in the rule would catch a block that silently drops lines in the middle.

## Decision

1. **A finding may carry a fix:** `fix: { startLine, endLine, replacement }`, lines of the new file and the text that replaces them whole (lines joined by `\n`, no trailing newline; empty deletes them). It is not part of what a reviewer reports; only a deterministic stage sets it, after anchoring, and only for a fix of exactly the finding's anchored lines.
2. **No stage sets it yet.** No safe deterministic extraction exists without a prompt change (see Context). The fix will come from a later, evaluated prompt change: the reviewer reports a replacement for its own `existingCode` quote, and the anchor stage turns it into a `fix` when the quote anchored unambiguously inside the diff (method `hunk`, not relocated or cross-file). This ADR lands the model, the report, SARIF and the rendering, so that change is a prompt and one mapping.
3. **Rendering, in `vcs-platform`, shared by both platforms.** An inline comment gets a suggestion block under the explanation only when the finding has a fix, its lines are in the diff, and the fix covers exactly the lines the comment is anchored to (`lineRange`); never on file-level findings, which have no inline comment. Each platform supplies the block's info string for a range: GitHub `suggestion` (the comment spans the range), GitLab `suggestion:-N+0` with N = end − start (the thread sits on the last line), and none beyond GitLab's 100 lines above.
4. **The replacement is posted exactly or not at all.** Model text elsewhere in a comment is neutralized by rewriting it (zero-width spaces), which would change the code a click commits. So the fence is longer than any backtick run in the replacement, which then cannot close it, and a replacement that holds what ocra would have to rewrite (an HTML comment opener, `/ocra`), a carriage return or a control, bidirectional or line-separator character (`isUnsafeCodePoint`, "Trojan Source"), or is longer than 20,000 characters gets no suggestion block. Inside a code block nothing renders as a mention, link or HTML, and GitLab runs no quick action.
5. **Reports carry it.** The JSON report gains an optional `fix` per finding (version 1, an added optional field). SARIF gets `fixes[].artifactChanges[].replacements[]` with the deleted region (whole lines) and the inserted text; a deletion's region runs to the start of the next line so no empty line is left.

## Note (2026-10-09): model text cannot post a suggestion of its own

Point 4's checks (exactly the anchored lines, posted as written) held only for ocra's own block: a model could write a `suggestion` fence in a finding's body or suggestion text, and both platforms offered it as a committable change. `safeMarkdown` now breaks the info string of every fence in model text that names a suggestion, with a zero-width space, in code and in text alike (#509). ocra's own block is added after model text is neutralized, so it is unaffected.

## Consequences

- Until the prompt change, no finding has a fix and nothing a user sees changes; the report schema and the rendering are ready and tested.
- The prompt change is a review-quality change and is evaluated like any other; this ADR is what it plugs into.
- A replacement with `<!--` or `/ocra` (an HTML file, a test of ocra itself) is not offered as a suggestion; the finding is still posted.

## Alternatives considered

- **Extract a code block from today's `suggestion` text:** 1 hit in 110 with the strictest rule, and no way to rule out a block that drops lines; rejected.
- **Neutralize the replacement like other model text:** changes the code a click commits; rejected for "post exactly or not at all".
- **A `~~~suggestion` fence:** sidesteps backticks, but GitLab's documentation describes backtick fences for suggestions; a longer backtick fence is CommonMark on both platforms.
