# ADR-0058: Guidelines as whole sections, and which reviewers get them

- Status: accepted; amends [ADR-0057](0057-review-context-budgets.md)
- Date: 2026-11-22

## Context

The repository's guidelines (`AGENTS.md`) are the largest source of review context: 38.6% of the golden set's first-prompt tokens, 3,200 to 5,000 tokens in every task on ocra's own cases (ADR-0057). Past 20,000 characters they were cut mid-sentence, in 148 of those tasks, without the reviewer knowing what it lost. Whether every reviewer needs them, or only the sections about the files it reviews, or only the `agents-md` reviewer, is a question for the paid ablation; the engine needs the three to exist first, with today's behaviour as the default.

## Decision

1. **Guidelines are read as sections** (`docs/guidelines.ts`): a heading of level 1 to 3 outside a code fence starts one; the text before the first heading is one too. The sections joined are the document again.
2. **A section is never cut.** A task is given, in the document's order, every section that applies and still fits 20,000 characters; one that does not fit is left out whole, and the headings of every section left out are listed after the given ones with the file tool to read them (at most 30). Only when even the first section that applies is over the limit is it cut, as before, and marked. A document within the limit is sent exactly as before.
3. **A section is about one part of the repository only when its heading names a path** (`## web/`, ``### `packages/core` ``); its subsections inherit that scope. Paths in a section's text are mostly examples of a rule that applies everywhere (the security section of ocra's own file names `review/prompt-text.ts`), so they never scope it: recall over tokens.
4. **`guidelineScope`** in the configuration, `--guidelines` on the command line, `ReviewOptions.guidelineScope` in the API, and `ocra-eval run` / `context --guidelines`:
   - `all` (the default): every section, to every reviewer;
   - `matched`: to every reviewer, the sections that apply everywhere and those scoped to a path the task's bundle touches;
   - `reviewer`: only to the reviewers that check the guidelines themselves (`requiresGuidelines`, today `agents-md`).
   A reviewer that checks the guidelines always gets every section: a change elsewhere can make any of them false.

## Consequences

- The ablation for the largest source is three runs on the same cases: `--guidelines all`, `matched` and `reviewer`, then `verdict`.
- On the four real guideline files checked (ocra, ocra-cloud, ocra-site, devot) no heading names a path, so `matched` gives what `all` gives; it pays off on a monorepo file written by area. `docs/guidelines-recall.fakes.ts` holds the recall cases: every section a change needs is given, and sections about other areas are not.
- Under `matched`, guidelines become bundle-specific and so leave the prompt prefix the bundles of a run share; under `reviewer`, the other reviewers' prompts lose them entirely. Both cost cache reuse or recall that only the eval can weigh.
- The golden set (65 cases, 1,386 tasks) measured with `ocra-eval context`: `all` gives guidelines to 482 tasks, 1.69M tokens (38.1% of 4.43M first-prompt tokens) and now cuts none, where the 20,000-character cut used to fall mid-section in 148 tasks; `matched` gives them to 436 tasks, 1.63M tokens (one case repository scopes headings by path); `reviewer` to 107 tasks, 0.38M tokens, and the whole first-prompt total falls by 29%, to 3.12M.
