# ADR-0067: What a review's time is made of, and eight tasks at once

- Status: accepted
- Date: 2026-11-23

## Context

ADR-0061 measured what ocra costs around the model calls and found little: about two seconds a review on a repository of ordinary size. The time a person waits for a verdict was not looked at.

Measured with `ocra-eval perf --latency-ms 1000` (the direct runtime, a scripted model that answers each request after one second) on two real changes:

| Change | Tasks | Model requests | Wall time, 4 tasks at once | 8 at once |
|---|---|---|---|---|
| 31 files | 26 | 154 | 45.5 s | 26.5 s |
| 42 files | 49 | 256 | 69.6 s | 39.3 s |

- **The time is the review tasks' requests divided by the tasks running at once.** In the first run the tasks made 143 of the 154 requests (their plan calls included): 36 seconds at four at once, of 45.5. Grouping, Verify (one request per file with findings, as many at once as tasks) and the judge are one request deep each. Nothing waits that could run: the walkthrough and the pre-merge checks already run beside the tasks, and a step's tool calls run together (ADR-0061).
- **What is left in series cannot move without changing a prompt.** Verify groups the findings of every task by file, so it starts when the last task ends; the judge reads what Verify kept. Starting either earlier changes what they are asked, which is a change of behavior to be decided with an evaluation, not here.
- **A rate limit cost a task everything it had done.** A refused request ended the attempt; after the model's pause the task started again from its first prompt and asked for every step a second time. Tasks running at once are refused together, so one limit threw away the work in progress of all of them. That is the price of running more tasks at once on a provider with a low limit, and the reason four was a careful default.

## Decision

1. **A rate-limited request waits and is sent again, inside the attempt.** The `ChainRunner` hands an attempt `RateLimits`: `waitOut(quota)` records the limit against the model as before (the shared pause, three pauses in a row, a daily limit) and resolves `true` once the pause is over, or `false` when the model is out of quota for the run or the task was stopped. The direct runtime's loop calls it for a refused request and, on `true`, asks the same step again with the conversation it has; a refused request is not counted as a step. On `false` the attempt ends with the error and the failback moves on, as before. The wait is announced as a task's progress, in the words used between attempts.
2. **Completions and the OpenCode runtime are unchanged.** A completion is one request, so starting again loses nothing. OpenCode owns its conversation; an attempt of its that ends on a rate limit starts again after the pause.
3. **Eight review tasks run at once by default** (`concurrency`, `limits.concurrency`), up from four. The same tasks get the same prompts; only the order in which they finish changes. Verify and the fix stage follow the same number.

## Consequences

- A review of many tasks takes a little over half as long where the provider's limit allows eight at once: 42% less on both measured changes. A change of four tasks or fewer, which is most small pull requests, takes as long as before.
- A provider that refuses the wider burst costs a wait, not the work: ocra Cloud's gateway allows 120 calls a minute and states a wait of 60 seconds, well inside what a run waits out. Where a limit keeps pausing a run, `concurrency` lowers the burst.
- An attempt's timeout keeps running while it waits, where a restarted attempt got a new one. A task that waits long enough to reach it fails over to the next model, as any timed-out attempt does.
- More tasks start before the first task of a reviewer has stored the prompt start they share (ADR-0064), so a few more of them store it instead of reading it: a handful of tasks' shared start a run, small beside the steps that follow.
- A run can end further above its spend limit: calls already running finish, and there are up to eight.
- Runtime plugins that implement `ModelAttempts.task` are handed one more argument and may ignore it.
- Verify and the judge stay in series behind the tasks. Running Verify beside them is the next cut, and needs the golden comparison.
