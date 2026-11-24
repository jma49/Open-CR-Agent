# ADR-0082: The performance reviewer runs at the full tier only

- Status: accepted
- Date: 2026-11-24

## Context

On 100 Sonnet reviews of the smoke tier (2026-11-23), the performance reviewer ran 80 tasks. Every one ended in a single step with only `task_done`: no file read, no finding. It was 6% of the bill, and 10% on cold runs, where a task's first prompt is stored at 1.25 times the input price. On the one case with a performance claim (elasticsearch delta copies), it missed the claim in all ten repeats.

The `lite` tier covers most everyday changes. The `full` tier is the riskiest: broad changes, or changes to sensitive paths, where a regression on a hot path is most likely to matter.

## Decision

The built-in performance reviewer's `minTier` goes from `lite` to `full`. A repository brings it back lower with `reviewers.performance.minTier`, and `--all-tiers` still runs every reviewer.

## Consequences

- A `lite` review no longer runs performance tasks. On the smoke tier, where it reported nothing, that is its whole cost: no finding is lost there.
- A real performance regression in a `lite` change goes unreported unless the team sets `minTier` back. The accuracy phase revisits the reviewer's prompt, since it reads nothing before ending; if it starts finding things, its tier is reconsidered with it.
- No prompt changes.

## Alternatives considered

- **Turning it off by default.** Saves more, but leaves even the riskiest changes without a performance pass.
- **Leaving it until the accuracy phase.** Keeps paying for tasks that, on the evidence, do nothing.
