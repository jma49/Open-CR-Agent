# ADR-0071: A model's declared context window

- Status: accepted
- Date: 2026-11-23

## Context

A review task's first prompt holds the diff of its bundle (up to 120,000 characters) and the context around it (up to about 34,000 tokens, ADR-0057), and its conversation grows with each file the reviewer reads, for up to 30 steps. That fits the windows of current hosted models, which is all the engine was measured on.

Inside a company the model is often self-hosted with a window of 16K or 32K tokens. Tested against a scripted endpoint with such a window, on a change of twelve files: plan calls of 22,000 to 31,000 tokens were refused (HTTP 400, "maximum context length"), every review task failed the same way, and the run ended with no file reviewed. The engine had no notion of a window, and the endpoint's refusal comes only after the request is built and sent.

## Decision

1. **A model may declare its window.** `providers.<id>.models.<model>.contextWindow` is the number of tokens one request may hold, the answer included, at least 8,000. Unset, nothing changes: the engine keeps assuming a large window, as for every model through OpenCode's catalog.
2. **The plan fits the smallest window.** The CLI passes the smallest window declared among the models its chains name as `ReviewLimits.contextWindow`. Core then holds a bundle's diff to a quarter of it (`bundlePolicyFor`), when bundling and when packing or spanning bundles in the matrix, so a large change becomes more and smaller tasks whichever model of a chain takes one. The smallest, because a task is planned before the failback picks its model.
3. **The direct runtime stops a conversation before it overflows.** The loop keeps a gauge of the conversation: the endpoint's own token counts once an answer came back, an estimate of four characters per token for what was said since, and for an endpoint that reports none. When the next request would leave less than 15% of the window, the turn ends. A review task then gets its wrap-up turn, which is not gated, and ends as `context_window`, a third incomplete ending next to `step_cap` and `stopped_early`: its files are partly reviewed, the review is incomplete, and the report and the summary say why and what to do.
4. **A prompt that cannot fit is not sent.** The attempt fails on that model with both sizes in its message, retryable, so the failback goes to the next model of the chain, which may have room.
5. **The context around the diff is not scaled.** Its budgets (ADR-0057) are per source and measured; cutting them by window would change what reviewers see in ways no eval has covered. The manual says that a window under about 32K leaves little room to read.

## Consequences

- A team with a small-window model gets a review that is planned to fit and ends honestly, instead of a run of refused requests. How much of a change such a model can review is still bounded by its window.
- The report's `ended` gains a value, and `incomplete` counts a third way; both are additive in the JSON report (schema updated).
- The OpenCode runtime plans with the window but runs its own conversation; it does not stop at the window. Declared models there keep OpenCode's defaults.
- Providers that ocra Cloud declares to the CLI carry no window yet: the provider entry of the contract would have to carry it, from a self-hosted server's `MODEL_ENDPOINTS`.
- Nothing changes without a declaration, so no prompt, rule or stage the golden set measures is affected. Not run against a live model yet.
