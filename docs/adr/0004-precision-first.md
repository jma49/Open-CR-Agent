# ADR-0004: Precision by default, recall via --ultra

- Status: accepted
- Date: 2026-09-24

## Context

Noisy reviewers lose developer trust quickly. OpenCodeReview deliberately trades recall for precision; Cloudflare reports about 1.2 findings per review after specialisation and judging.

## Decision

The default mode optimizes precision: risk-tiered reviewer selection, strict Judge filtering, suppressed low-value suggestions. An opt-in `--ultra` mode runs all reviewers, always plans, samples twice, searches callers of changed symbols, and relaxes Judge filtering with low-confidence labels.

## Consequences

- Both modes are tracked separately in the eval package (precision, recall, F1, cost, latency).
- Features that raise recall at a precision cost belong in `--ultra` first.
