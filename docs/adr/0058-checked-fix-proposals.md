# ADR-0058: Checked fix proposals

- Status: accepted
- Date: 2026-11-22

## Context

ADR-0029 landed a finding's `fix` (a replacement of whole anchored lines), its report and SARIF fields, the committable suggestion block on both platforms, and the upload of fixes to ocra Cloud, whose console commits one to the pull request. No stage sets it: ADR-0029 planned for reviewers to report a replacement of their own quote, a prompt change for every reviewer that waits on the evaluation. So real reviews never carry a fix, and the console's commit button has nothing to commit.

A fix is committed in one click, so a wrong one costs more than none. Paid evaluation is on hold until the product is polished, so whatever produces fixes has to be safe without it: checked by code, cheap, and off unless asked.

## Decision

1. **A fix stage after the judge**, so fixes are asked only for findings the report keeps (`fix/`, `pipeline/fix-stage.ts`). It amends ADR-0029 point 2: the reviewers' prompts stay as they are, and fixes come from a separate call.
2. **Candidates** are findings anchored by `hunk`, in the diff, not ambiguous, not low confidence, spanning at most 30 lines; the most severe first, at most 10 per run.
3. **One call per file** with candidates, on a new `fixer` role (standard tier, `roles.fixer` in the configuration). It is a plain completion: no tools, nothing read or written beyond the prompt, so the read-only review guarantee is unchanged. The prompt gives each finding's explanation, the reviewer's suggestion, the exact lines to replace and a numbered excerpt of the file at head, all as data. The model answers a replacement or `null` per finding; asking for `null` when the fix is not a local edit of those lines is part of the prompt. The calls are charged to the spend limit and stop when it is used up, and the judge's call is now charged too, since another stage follows it.
4. **Every answer is checked by code** (`fix/check.ts`) and dropped, never repaired, when a check fails:
   - the lines still are what the finding quoted at the reviewed head (its quote signature), so the fix applies to that head;
   - it replaces exactly the anchored lines, which the shape of `fix` guarantees, and changes them;
   - it holds no carriage return or control, bidirectional or line-separator character (`isUnsafeCodePoint`);
   - it is at most 4,000 characters and adds at most 20 lines;
   - the patched file parses with no more errors than the file at head, by tree-sitter (`SyntaxChecker`, implemented by `@open-cr-agent/code-graph`). A file in a language without a grammar gets no fix and costs no call.
5. **The report says what happened**: `fixes: { asked, proposed, rejected: [{ fingerprint, reason }] }`, reasons `declined`, `failed`, `stale`, `unchanged`, `unsafe`, `too_large`, `no_parser`, `syntax`. The terminal shows a fix under its finding.
6. **Off by default**: `fixes: true` in the configuration, `--fixes` for one run, or the account's `fixes` setting from ocra Cloud. It stays off until the evaluation below shows fixes are right often enough to offer by default.
7. **The evaluation is one command away**: `ocra-eval run --dataset golden --tier smoke --fixes` passes `--fixes`, and the golden summary counts the findings that carried a fix and whether those findings were right or wrong. Whether the fix itself is right is not scored yet; the cases mined from fix commits (`golden-import --from fixes`) hold the author's fix to compare with when it is.

## Consequences

- With fixes on, a pull request comment gets a suggestion block when ADR-0029's rendering rules allow it, and ocra Cloud gets fixes to commit. With them off, nothing changes.
- A fix that parses can still be wrong: the checks bound where and how much it changes, not whether it is right. The judge and Verify have already kept the finding, and the person still clicks to commit it.
- The stage adds at most one standard-tier call per file with candidates, after the judge.
- A tree-sitter parse cancelled by its time budget left the parser holding it, so the next parse resumed it on another file. Both the symbol extractor and the syntax check now reset the parser.

## Alternatives considered

- **Reviewers report the replacement** (ADR-0029's plan): changes every reviewer's prompt and so the review itself, which waits on the evaluation; a separate stage can ship behind a switch.
- **An agent with tools that edits a checkout**: breaks the read-only guarantee and needs a writable tree; a completion over the lines is enough for a local edit.
- **Run the project's build or tests on the fix**: runs code from the reviewed repository, which ocra never does (AGENTS.md, Security).
