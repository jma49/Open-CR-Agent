# ADR-0018: The finding is the specification

- Status: accepted
- Date: 2026-10-01

## Context

The roadmap (2026-10-01) positions ocra as the engine review agents are built on. What such agents, analyzers, sinks and evaluators exchange is the finding, so the finding needs a written specification before any of them exists outside this repository, and the specification has to be the one the code already honors, not a new model beside it.

The published shape has existed since the JSON report got `"version": 1` (`toReportOutput`), with the rule that a version only gains optional fields. It lacked two things. A finding did not say where it came from: the reviewer, yes, but not the task that produced it, the model that served that task, or what it cost, so a report could not be read per model or per task. And the shape was described in prose on the CLI page, with its key lists pinned by a test; nothing outside this codebase could validate a report or generate a reader from it.

## Decision

1. **`Finding` is the one shared model, and the JSON report is its published form.** There is no second finding type for analyzers, sinks or the evaluation harness: an external source is mapped into `Finding` once, at its boundary, and a sink reads the report. The internal `Finding` keeps fields the report leaves out (the per-run `id`, the anchor's method, the quote signature, the platform state); the report carries what a reader can rely on.
2. **Provenance is part of the finding.** `provenance.task` names the entry in `tasks` that reported it, which carries the reviewer, bundle, files, outcome, duration and now `usage` (tokens and dollars, the task's share of a plan call included). `provenance.model` is the model that served the task when the runtime names it; the runtime's finding event carries it as an optional field. A finding's cost is its task's; cost is not divided among findings.
3. **Identity.** `fingerprint` (reviewer category, file, normalized quoted code) is the identity across runs and the key of memory, dismissals and labels (ADR-0012 says a label belongs to one claim on that code). `id` is per run and internal.
4. **Location is a quote, then lines.** A finding is anchored by the code it quotes; the model never supplies line numbers. `lines` is present when the quote was found, absent when the finding is file-level; the method by which it was found is reported in aggregate (`anchoring`), not per finding.
5. **Confidence is three-valued evidence, not a number.** `verification` is `confirmed`, `uncertain` or `unchecked`, set by an independent step that checks the finding against the diff. No field carries a model's own estimate of its confidence; `lowConfidence` marks what the judge would have dropped under `--ultra`.
6. **Severity keeps its blocking semantics.** `critical`, `warning`, `suggestion`; the verdict is computed by code from the judged findings (ADR-0004, `judge/verdict.ts`).
7. **The lifecycle is the report's layout, in this version.** A reported finding is refuted (`refuted`), remembered (`remembered`), merged, dropped or recalibrated by the judge (`judgement`), or kept (`findings`, with `status` `new` or `unfixed`). Against an earlier review of the same change it is `fixed` only when its code is gone (ADR-0009), `notReproduced`, `notRechecked`, `unchanged` or `dismissed` (`rereview`). A single status field holding every state would change the layout, so it waits for version 2.
8. **No open bag.** There is no `metadata` field. A field is added when a reader needs it, under the version rule.
9. **The schema is generated, published and tested.** `reportOutputSchema` (Zod, every object strict) describes exactly what `toReportOutput` writes; `reportJsonSchema()` renders it as JSON Schema draft 2020-12; `npm run schema` writes `docs/schema/report.v1.json`, and a test fails when the file and the schema differ, or when the output gains a field the schema does not know. External findings (SARIF in) will be mapped against this schema, not against a schema of their own.

## Consequences

- Readers can validate a report and generate types from `docs/schema/report.v1.json`, and read findings per model and per task.
- Every runtime may name the model that produced a finding; one that does not leaves `provenance.model` absent, and the finding is still valid.
- `tasks[].usage` and `findings[].provenance` are additions to version 1: optional in the schema, always written by this version.
- Adding a field to the output without the schema fails a test; the schema and the published file cannot drift from the code.
- Version 2, when it comes, is where the lifecycle becomes one status and anything else this version left in prose becomes a field.
