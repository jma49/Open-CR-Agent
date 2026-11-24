# ADR-0082: The performance reviewer runs at the full tier, and at lite on hot paths

- Status: accepted
- Date: 2026-11-24

## Context

On 100 Sonnet reviews of the smoke tier (2026-11-23), the performance reviewer ran 80 tasks. Every one ended in a single step with only `task_done`: no file read, no finding. It was 6% of the bill, and 10% on cold runs, where a task's first prompt is stored at 1.25 times the input price. On the one case with a performance claim (elasticsearch delta copies), it missed the claim in all ten repeats.

The `lite` tier covers most everyday changes. The `full` tier is the riskiest: broad changes, or changes to sensitive paths, where a regression on a hot path is most likely to matter.

Running it at `full` only would also drop the one claim it exists for: the elasticsearch case is a `lite` change, and the recall-ceiling gate measured that claim as unreachable without it (57 of 57 reachable became 56).

## Decision

The built-in performance reviewer's `minTier` goes from `lite` to `full`, with one exception: on a bundle with a file whose path names code that runs per request, event or row (cache, query, queue, pool, batch, stream, buffer, storage, database, render, cluster and a few more, matched as whole path words the way triage matches sensitive paths), it still runs from `lite`. A reviewer's scope states this as `focus`: path words and the tier they bring it down to. The words are read from the files the reviewer would see, so a test file on such a path does not count.

A repository's `reviewers.performance.minTier` replaces both tiers, and `--all-tiers` still runs every reviewer.

## Consequences

- A `lite` review runs performance tasks only on hot-path bundles. Packing keeps those to one task in most changes.
- The recall ceiling stays at 57 of 57.
- A word is a weak signal both ways. A false match costs one packed task; a hot path with none of the words, in a `lite` change, goes unreported unless the team sets `minTier` back. "index" is left out because it names entry modules far more often than indexes. The accuracy phase revisits the reviewer's prompt, since it reads nothing before ending; if it starts finding things, its tier is reconsidered with it.
- No prompt changes.

## Alternatives considered

- **`full` only.** Cheapest, but loses the reachable performance claim and with it the gate's baseline.
- **Turning it off by default.** Saves more, but leaves even the riskiest changes without a performance pass.
- **Leaving it until the accuracy phase.** Keeps paying for tasks that, on the evidence, do nothing.
