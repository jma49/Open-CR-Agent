# ADR-0057: Review context by source, its budgets and its ablation

- Status: accepted
- Date: 2026-11-22

## Context

A review task's prompt has grown one source at a time: the change request, the list of changed files, linked tasks (ADR-0052), the repository's guidelines and rules, accepted findings, learnings (ADR-0037, ADR-0044), project documents (ADR-0052), callers (ADR-0039), analyzer results (ADR-0042) and the plan phase's checklist. Each came with its own limits, decided on its own, and nothing showed what the sources add up to on a real change, which of them grow without a bound, or whether one repeats another.

Every source should also earn its place: a review with it should find more, or the same at lower cost, than a review without it. That comparison needs paid runs, which wait until the product is polished; what it needs from the engine is a way to leave one source out and nothing else.

## Decision

1. **The prompt is built as parts, one source each** (`reviewPromptParts`, `review/context-sources.ts`); `buildReviewPrompt` joins them, so the prompt a task sends and the parts that are counted cannot differ.
2. **`ocra review --plan` counts each part.** Every task in the JSON plan carries `context`: per source, its tokens (four characters per token, as the rest of the plan), `cut` (texts held to a limit and lists cut short) and `duplicateTokens` (lines of 40 characters or more that an earlier part of the same prompt already holds). A new optional field of plan version 1.
3. **`ocra-eval context` measures the golden set for free**: it plans every case as the eval runs review it and reports per source the tasks that have it, its tokens and share, the mean and the largest per task, cuts and duplicates (`context.md`, `context.json`).
4. **Every source has a budget.** `review/context-budget.test.ts` feeds each source as large as the stages before the prompt let it grow and holds it to a token budget, and the whole context around the diff to a total. A source with no bound of its own gets one in the prompt, marked where it cuts:
   - the changed-files list: the first 150 files, then how many more (each task carries the list);
   - accepted findings: the last 20 listed on the bundle's files, title and reason clipped (memory only grows; `applyMemory` still drops every remembered finding by fingerprint);
   - the repository's rules: 12,000 characters, like the guidelines' 20,000;
   - titles of linked tasks, their parents and learnings: 300 characters; subtask titles: 120.
   Inputs under the limits render byte for byte as before.
5. **A run can leave sources out**: `ocra review --without <sources>` (`ReviewMode.without`), passed through by `ocra-eval run --without`. The sources are `description`, `changed_files`, `linked_tasks`, `guidelines`, `rules` (the repository's, not the reviewer's own), `accepted`, `learnings`, `project_docs`, `callers` and `analyzer`. A source left out is not rendered; leaving out `guidelines` also skips the reviewers that need them, and leaving out `callers` skips their search. The flag is recorded in the configuration hash, so runs with and without a source never resume each other's tasks or compare as one setup without `--allow-mixed`. The system prompt, the diff and the plan phase are the review itself and cannot be left out.

## Consequences

- The per-source ablation is one command per source once paid runs start: `ocra-eval run --label without-<source> --without <source>` against a baseline, then `ocra-eval verdict`. A source that does not pay for itself is a candidate for removal, and a new source arrives with its part, its budget and its switch.
- Verify and Judge prompts are not counted: their size depends on the findings, which a plan does not have. Their inputs are already bounded (excerpt lines, related code, finding text, findings per task).
- The golden cases run with `--no-repo-config` on repositories without learnings, project documents or linked tasks, so their measurement shows those sources absent; their budgets come from the synthetic inputs of the budget test, until cases with them exist.
- The first measurement (65 golden cases, 1,386 tasks, 4.46M first-prompt tokens) was the same before and after the new limits: no case reaches them. The guidelines are the largest source, 38.6% of all tokens: on ocra's own cases `AGENTS.md` adds 3,200 to 5,000 tokens to every task and is cut at its limit in 148 tasks. Then the system prompts (27.5%), the diff (15.3%), rules (8.9%), the changed-files list (5.5%) and the change request (2.7%). No source repeats another's lines. Guidelines are the first source for the paid ablation: whole, chosen by the changed files, or only for the reviewer that checks them.
