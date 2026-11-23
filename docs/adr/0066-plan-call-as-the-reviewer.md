# ADR-0066: The plan call is asked as the reviewer

- Status: accepted
- Date: 2026-11-23

## Context

A review task for a bundle of five files or more, or under `--ultra`, starts with a plan call: one request that turns the bundle into a short checklist, which the task's prompt then carries. The call sent the task's own prompt, files included, under a system prompt of its own.

A provider's prompt cache matches a request from its start: the tools, then the system prompt, then the conversation. With another system prompt and no tools, the plan call shared nothing with the task it prepared, so a large bundle was sent at the full input price once and stored at the storing price right after.

Measured with `ocra-eval perf` (ADR-0061) on a 27-file change, 44 tasks, 5 of them with a plan call:

| | Plan calls' input | Review input that repeats an earlier request |
|---|---|---|
| Before | 38,784 tokens | 84% |
| After | 45,758 tokens | 86% (about 33,000 tokens more) |

The plan calls grow by the tool definitions and the reviewer's system prompt. What the tasks no longer send fresh is about a tenth of the review's fresh input on this change, more where bundles are larger.

## Decision

1. **The plan call is made as the reviewer.** It has the reviewer's system prompt and the task's prompt up to the end of the files, and ends by asking for the checklist where the task's prompt ends by asking for findings. There is no separate planner prompt.
2. **A completion may say a task follows it** (`CompletionRequest.sharedPrefixes`): where in its prompt the starts end that the task opens with too. The direct runtime then sends the request as it would that task's first, with the review tools, and on the Messages wire stores those starts, the last of them the end of the files. The tools are offered so that the request starts as the task's does; a call the model makes with them is not run.
3. **The task's prompt says where the start it shares with its plan call ends** (`AgentTaskSpec.sharedPrefixes`, after the run-wide starts of ADR-0064). The Messages wire marks the first two starts, as before, and only ends a block at a later one: a block boundary is where a request finds what another stored.
4. **A runtime that makes plain completions only ignores the field.** On the OpenCode runtime the call changes only in its wording.

## Consequences

- A task with a plan call reads its files from the prompt cache on its first request instead of storing them a second time. The plan call itself costs a quarter more on what it stores.
- The plan is written under the reviewer's instructions, with the tools in view. A model that calls a tool instead of answering leaves the task without a checklist, as a failed plan call always has.
- The prompts fingerprint in a report's provenance changes: runs before and after are told apart.

## Alternatives considered

- **Keeping the planner's own system prompt and storing nothing.** What the code did. The plan call's input is paid twice.
- **Forbidding tool calls with `tool_choice`.** It changes how the provider keys the conversation in its cache, so the task would not read what the plan call stored.
- **Dropping the plan phase.** Needs evidence that the checklist does not help; the golden cases are too small to give it.
