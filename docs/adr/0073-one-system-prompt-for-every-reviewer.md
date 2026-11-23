# ADR-0073: One system prompt for every reviewer

- Status: proposed; amends [ADR-0064](0064-review-input-tokens.md), [ADR-0066](0066-plan-call-as-the-reviewer.md) and [ADR-0072](0072-one-task-stores-a-shared-start.md)
- Date: 2026-11-23

## Context

A provider's prompt cache reads a request from its start: the tools, the system prompt, then the conversation. Each reviewer had a system prompt of its own, so the tasks of two reviewers shared the tools and nothing else, however much of their first message was the same.

Much of it is. Every task of a run is given the change request, the changed files and the guidelines; the reviewers of one bundle are given the same files. The hosted reviews of small changes (ocra Cloud, 2026-11-23) show what that costs: a change of one or two files runs four or five tasks, one for each reviewer, on 14,000 to 55,000 input tokens, most of them the first prompts, each stored at a quarter above the input price. On a larger change the security and performance reviewers get the same packs (ADR-0068), and the documentation and guidelines reviewers the same parts of the whole change (ADR-0065).

## Decision

1. **The system prompt is the same for every reviewer.** It says that the reviewer reviews a bundle of a pull request, who is trusted (the trust boundary each reviewer's prompt used to open with, once), and the turn budget. It says that the task is defined by it and by `<ocra_reviewer_brief>`.
2. **A reviewer's instructions are its brief,** sent in `<ocra_reviewer_brief>` after the files: the text of `ReviewerDefinition.systemPrompt`, a built-in reviewer's as it was without the trust boundary. The field keeps its name, which plugins use. The brief is ocra's text or a trusted plugin's; data cannot form the tag (`data()`), as with every section.
3. **The prompt's order is what the run shares, what the bundle's reviewers share, then the reviewer's own:** the change request, the changed files, the linked tasks; the guidelines; the accepted findings, learnings, project documents and files; then the callers, the analyzer results, the brief, the rules, the plan and the closing instruction. The rules moved after the files because the reviewer's own are part of them.
4. **Every task says where its files end** (`sharedPrefixes`), not only one with a plan call. The Messages wire stores the two longest starts a task shares, the guidelines' end and the files', and only ends a block at the shorter one, which a task with other guidelines still finds.
5. **A first request waits for each start another request is storing,** shortest first (ADR-0072): the run's start, then the bundle's.

## Consequences

- The prompts fingerprint covers the shared system prompt and each brief.
- Every task after a run's first reads the tools, the system prompt, the change and the guidelines; a reviewer whose files another reviewer was given reads those too. With the scripted reviewer of `ocra-eval perf`, the input tokens that repeat no earlier request fall from 208,445 to 193,339 on a change of 28 files (17 tasks) and from 89,665 to 82,987 on one of 4 files in 8 tasks, where it puts every file in a bundle of its own; a change of one bundle shares more.
- A task with a plan call stores its brief and rules again after the call, about 1,400 tokens: the call and the task read alike only to the end of the files.
- A reviewer's instructions reach the model in the conversation, after text an attacker may have written. What keeps them apart is what keeps every section apart: only ocra writes `<ocra_` tags, and the system prompt names the one section that defines the task.
- The callers come after the files and are not stored for the bundle's other reviewers.

## Evaluation

Pending: `eval compare` on the smoke tier and on the five large cases of ADR-0066, three repeats a side.

## Alternatives considered

- **A shared first part of each system prompt.** The tools and the trust boundary together are under the 1,024 tokens most models need to store a start.
- **One task for all reviewers of a small change.** One conversation reads the files once, but a reviewer's findings would depend on the passes before it, and the passes would run one after another.
