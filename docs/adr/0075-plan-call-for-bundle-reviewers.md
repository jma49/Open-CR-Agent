# ADR-0075: Only a reviewer that works bundle by bundle plans first

- Status: accepted; amends [ADR-0066](0066-plan-call-as-the-reviewer.md)
- Date: 2026-11-23

## Context

A review task for a large bundle (five files or more, or 40,000 diff characters) starts with a plan call: one request that turns the bundle into a short checklist for the reviewer's steps.

The rule was written when every reviewer had a task per bundle. Since [ADR-0065](0065-whole-change-reviewers.md) and [ADR-0068](0068-packed-reviewers.md) the docs and guidelines reviewers take the change as a whole and the security and performance reviewers take packed bundles, so their one task is over the size on most changes of more than a few files. The correctness reviewer, whose bundles stay small, rarely plans.

Measured on 100 reviews of the golden smoke tier with claude-sonnet-5-5 (two `ocra-eval compare` runs): 70 plan calls, all for those four reviewers, cost 10.6% of the bill. The performance and security tasks that followed a plan call ended without reading a file.

## Decision

Outside `--ultra`, a task plans first only when its reviewer has a task per bundle (`span` unset or `"bundle"`) and the bundle is large. `--ultra` plans every task, as before.

## Consequences

- A review of a change with a large packed or whole-change task makes one model call fewer for each such task.
- Compared on the golden smoke tier (claude-sonnet-5-5, 3 repeats a side): no metric worse, the required claims found as often, cost per reviewed change $0.0745 to $0.0436. The base side runs first and warms the provider's prompt cache for some of what the other side reads, so part of that difference is the order of the runs.
- `--plan` counts fewer plan calls.
- A plugin's reviewer with `span: "packed"` or `"change"` no longer plans outside `--ultra`.

## Alternatives considered

- **Dropping the plan phase.** ADR-0066 left it for want of evidence; the smoke tier still has no large correctness bundle to give it.
- **Capping the plan call's answer.** Its output is under 1% of the bill; the cost is its input.
