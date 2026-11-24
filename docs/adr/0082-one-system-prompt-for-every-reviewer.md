# ADR-0082: One system prompt for every reviewer, its own instructions after the files

- Status: accepted; amends [ADR-0064](0064-review-input-tokens.md) and [ADR-0072](0072-one-task-stores-a-shared-start.md)
- Date: 2026-11-24

## Context

A provider's prompt cache keys a stored start on the tools, the system prompt and the messages, in that order. Every review task has the same tools, but each reviewer had its own system prompt, so the start it shares with other tasks (the change request, the changed files, the guidelines; ADR-0064) was stored once for each reviewer, and the bundle's files, which every reviewer of the bundle is given, once for each task.

On 100 Sonnet reviews of the smoke tier (2026-11-23), storing input was 43% of the bill. Most changes there are one or two bundles, and the correctness, security and performance reviewers run on the same model over the same files: three tasks stored the same change and the same files, each at 1.25 times the input price, where one store and two reads at 0.1 would do. Of 516 tasks, 219 ended in one step with only `task_done`; for those, storing the start was nearly the whole cost.

## Decision

1. **Every reviewer has one system prompt** (`REVIEW_SYSTEM_PROMPT`): who the reviewer is in ocra, the trust boundary and the turn budget. A reviewer's `systemPrompt` (built in or from a plugin) is sent as `<ocra_reviewer>` in the first message; the trust boundary names it as ocra's, and data cannot open or close it (`data()` neutralizes every `<ocra_` tag).
2. **The first message is ordered from what most tasks share to what one task has:** the change request, the changed files and the linked tasks; the guidelines; what belongs to the bundle (accepted findings, learnings, project documents, its files); then the reviewer's part (`<ocra_reviewer>`, the rules); then callers, analyzer results, the plan and the closing instruction.
3. **A task says where the bundle ends** (`sharedPrefixes`), after the two starts it already named. A plan call says too where the reviewer's part ends, which its task shares with it (ADR-0066).
4. **On the Messages wire a conversation whose first message has a shared start leaves its system prompt unmarked** and marks three starts instead of two, since the first start holds the system prompt. A call without one marks its system prompt as before. ADR-0072 needs no change: the start it waits on now holds no reviewer's text, so the first task of any reviewer on a model stores it and the others wait.

## Consequences

- On a change of one bundle, the tasks of correctness, security and performance store the change and its files once and read them twice; the documentation and guidelines reviewers, on the light model, do the same between them. A change of several bundles shares the change and the guidelines across reviewers, and each bundle's files with the packed reviewers where their tasks cover the same bundle.
- The prompt changes: the reviewer's instructions move from the system prompt to after the files, and the trust boundary is said once for all reviewers. The smoke-tier comparison is linked in the pull request.
- `--plan` and `ocra-eval context` count the reviewer's part as its own source, `reviewer`; `system` is now the same for every task.
- The prompt hash covers the shared system prompt and each reviewer's part, so it changes once with this release.
- The chat completions wire and the OpenCode runtime mark nothing; providers that cache a repeated start on their own see a longer one.

## Alternatives considered

- **Keeping each reviewer's system prompt and putting the files first in the message.** The system prompt comes before the messages in the cache key, so nothing would be shared across reviewers.
- **One task per bundle reviewing for every concern.** Fewer stores still, but it is a different review; the single-agent setup of `ocra-eval` measures that baseline.
