# ADR-0061: What a review costs around the model, measured and held to a budget

- Status: accepted
- Date: 2026-11-23

## Context

Nothing measured what ocra itself costs in a review: the time, memory, git processes and prompt tokens around the model calls. ADR-0057 counts the first prompt of each task; the eval runs record what a paid review spent. Neither shows where the engine's own time goes, and a change that starts a git process per file or doubles a prompt would pass every test.

A first profile (2026-11-23, 4 cores, a scripted model that answers at once, the direct runtime):

- **On ocra's own repository** (about 1,000 files) a review of 50 files, 60 tasks and 293 model requests takes 2.1 s: 0.3 s to start, 0.5 s to plan, the rest tool calls, anchoring and the report. 38 git processes. The process is idle half of that time.
- **On a repository of 32,000 files** the same kind of review took 98.7 s, all of it `git grep`: a search at a revision reads every blob of the tree, 0.8 s and two CPU-seconds whatever it looks for, and 242 of them ran, up to four at once. A batch whose output passed 4 MB was searched again one literal at a time, in parallel: 174 searches asked for together started 174 greps and ran a 15 GB machine out of memory.
- **Input tokens are the cost.** The 50-file review sends 3.7 million input tokens, 83% of which repeat the start of an earlier request (the prompt order ADR-0057 keeps). Every step resends the conversation.
- **The OpenCode runtime** adds about 4 s per run (1.4 s to start the server, 1.4 s to read its catalog, about 0.3 s per step) and one model request per review task: after the done tool, OpenCode asks the model once more, with the whole conversation. On the scripted reviewer that is 60 of 353 requests and a quarter more input tokens.

## Decision

1. **`ocra-eval perf` measures one review of a local range** with the real CLI and a scripted model on this machine (`packages/eval/src/perf/`): wall time, the ocra process's CPU time and peak memory (a module loaded into it reports `process.resourceUsage()` as it exits), git processes by command (`GIT_TRACE`), and per kind of model call the requests, input tokens, largest request and the tokens that repeat the start of an earlier request. The scripted model reviews every task the same way, so the same change gives the same requests. `--latency-ms` paces it like a model; `--runtime opencode` measures the default runtime.
2. **A budget holds what is deterministic.** `--budget <file>` exits 1 over a ceiling. `packages/eval/src/perf/measure.e2e.test.ts` reviews a synthetic change (240 files, 16 changed) within `evals/perf-budget.json`: git processes, model requests and input tokens a little above what they are, CPU time and memory with room for a slow runner. Wall time has no ceiling in CI: it measures the runner. A change that raises a ceiling says why in its pull request.
3. **One `git grep` runs at a time** (`vcs-local/src/search.ts`). Searches asked for while one runs share the next, as those of one turn already did. Its output is read line by line and never buffered whole: each literal keeps what a search of its own returns (20 lines a file, 100 in all, within 4 MB of output), and the grep is stopped once every literal has that, so a batch is never searched again and a common name costs a fraction of a scan. Only a line longer than a search reads sends a batch back to one grep per literal, one after another.
4. **The direct runtime runs the tool calls of one step together,** as OpenCode does, so the searches of a step share one grep.

Answers are unchanged: 174 literals (frequent, rare, absent, with regular-expression characters) asked one at a time, together and staggered return the same matches before and after on both repositories, and the four measured reviews produce the same reports.

## Consequences

- The 32,000-file review takes 63.9 s instead of 98.7 s with a model that answers at once (75.7 s instead of 116.0 s at 300 ms a request), with 67 greps instead of 242 and a peak of 624 MB instead of 963 MB. On ocra's own repository nothing changes but the grep count (23 instead of 33).
- What is left there is `git grep` itself. Going further needs an index of the revision's text, kept in memory or on disk: a new component with its own memory bound, to be decided when a repository of that size is a real case.
- The request OpenCode makes after the done tool is not removed. Aborting the session when the tool runs loses the usage of the step that called it (OpenCode records a step's tokens when the step ends), and the cost report must stay whole (AGENTS.md, Performance and cost). It needs a way to end a session from a tool result.
- Verify, Judge and plan-phase prompts are counted here for the first time, by the scripted reviewer's findings; ADR-0057's per-source counts remain the measure of the review prompt.
