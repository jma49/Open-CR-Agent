# ADR-0072: One task stores a shared start, the others wait for it

- Status: accepted; amends [ADR-0064](0064-review-input-tokens.md)
- Date: 2026-11-23

## Context

A review's tasks open with the same start for each reviewer: the tools, its instructions, the change request, the changed files and the guidelines. On the Messages wire the start is marked for the provider's prompt cache (ADR-0064), so a task reads at a tenth of the input price what an earlier task stored at a quarter above it.

A provider serves a stored start only once the answer to the request that stored it has begun. Requests sent together find nothing and each store it. ADR-0064 accepted that for each reviewer's first task; since then eight tasks start at once (ADR-0067) and the security and performance reviewers pack their bundles into few tasks (ADR-0068), so the first eight are mostly the correctness reviewer's.

On a change of 28 files in ocra Cloud (17 tasks), the first eight tasks are six of the correctness reviewer, one of security and one of performance. The six share a start of about 3,400 tokens (tools 600, instructions 860, change and guidelines 1,970), and five of them store what the sixth stores: about 17,000 tokens at 1.25 times the input price where 0.1 would do. The two tasks each of the documentation and guidelines reviewers do the same when they start together, and so do plan calls (ADR-0066), which open as their tasks do.

## Decision

1. **The first request with a start goes at once; a request that opens with the same start waits until that one's answer has begun** (`SharedStarts`, one for a runtime). The start is the endpoint, the model, the system prompt and the prompt up to its first shared offset (`AgentTaskSpec.sharedPrefixes`, `CompletionRequest.sharedPrefixes`).
2. **The answer has begun at the first event of its stream.** A request that ends without one (a refusal, a dropped connection) lets the others go too: they are not queued behind a second attempt.
3. **A wait ends after ten seconds or with the task's signal,** and the request is sent as it would have been.
4. **Only on the Messages wire, and only a conversation's first request.** Later steps read what their own conversation stored. The chat completions wire marks nothing and answers in one piece, so there is no moment to wait for short of the whole answer.

## Consequences

- No prompt changes by a character, and no request is added or removed: no evaluation was run.
- Each reviewer's start is stored once a run instead of once for every task that starts with the first. On the change above that is five stores fewer for the correctness reviewer, about 20,000 tokens at the input price; the saving grows with the guidelines, not with the change, since only the tasks that start together stored twice.
- The tasks that wait start later by the time the first answer takes to begin, once a run for each reviewer. A change with one task for each reviewer waits for nothing.
- Not measured on a paid model: the order of the requests is checked against the wire's test endpoint. `ocra-eval perf` counts a start as repeated whenever an earlier request had it, answered or not, and its scripted model speaks chat completions, so it shows no difference.
- If the first request is rate-limited, the others go when it is refused and store the start as before.

## Alternatives considered

- **Starting one task for each reviewer and holding the rest in the pool.** The pool knows cells, not requests: a task with a plan call opens twice, and a runtime that caches nothing would wait for no gain.
- **Waiting for the whole first answer.** Certain on any provider, but it costs a model request of wall time on every change with two tasks of one reviewer.
- **Sending a request of one token ahead of the tasks to store the start.** An extra request for each reviewer on every run, most of which have one task for it.
