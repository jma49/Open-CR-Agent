# ADR-0021: The reviewer as a declared entity, and finding processors at two insertion points

- Status: proposed
- Date: 2026-10-02

## Context

M10 item 5 of the roadmap: "scope, tool set and output schema declared, not only a prompt and a tier; finding processors at the two insertion points." Today a reviewer is `ReviewerDefinition`: an id, a category, a model tier, a system prompt, an optional scope (lowest risk tier, ignored globs, needs guidelines) and optional rules. Every reviewer is offered every review tool plus every registered tool, and every one reports through the one `report_finding` schema. After Execute the pipeline deduplicates, applies memory and reconciles with the prior review; after Verify it judges; nothing outside core can touch findings between those stages except by rewriting the report a listener sees.

The roadmap's order rule says a contract is extracted when the reference reviewer or a second real implementation needs it, never ahead of that. This record proposes the shape so that the first use lands on a decided design, and says which parts have a use today.

Drafted with Claude Fable 5.1; the maintainer decides.

## Decision (proposed)

1. **`ReviewerDefinition` gains `tools?: readonly string[]`**, the names of the tools the reviewer may call, drawn from the review tools and the registered tools; absent, all of them, as today. Both runtimes offer a task only its reviewer's tools (the OpenCode runtime already builds a tool map per agent; the direct runtime filters its function specs), so a reviewer that reads documentation never gets `code_search`, and a plugin's tool reaches only the reviewers that name it. The matrix refuses a definition naming a tool nobody registered.
2. **The output schema stays one**, `report_finding`'s, which is the Finding specification's input (ADR-0018). A reviewer-specific extension has no use yet; when one appears it is a Zod extension of that schema validated in core, never a second shape of finding.
3. **Finding processors** are registered by plugins with `ctx.registerFindingProcessor({ at, process })`, `at` being `"execute"` (after Execute, deduplication and memory, before Verify) or `"verify"` (after Verify, before Judge). A processor receives the findings with a read-only view of the change (paths, the diff, the risk tier, the repository guidelines) and returns, per finding, `keep`, `drop` with a reason, or `downgrade` to a lower severity with a reason; it can neither raise a severity nor add a finding, so the pipeline's guarantees on precision, verification and budget hold whatever a processor does. Decisions are recorded on the finding (`provenance.processed`: processor name, decision, reason) and listed in the report, so a dropped finding is observable, never silent. Processors run in registration order, within a timeout, and a processor that throws is a warning: its decisions are `keep`.
4. **Conformance**: a processor suite in core checks that a processor cannot raise, add or reorder, that its reasons reach the report, and that a throwing processor changes nothing. A reviewer suite checks that a tool a reviewer does not name is never offered to it by either runtime.

## What has a use today, and what waits

- `tools` (1) has a security use now: least privilege per reviewer, and a registered tool scoped to the reviewer that needs it. It can land alone.
- Processors (3, 4) have their first real customer in M12's organization policy (excluded paths, mandatory reviewers) and in evaluation (the adversarial tier's canary check). Under the order rule they land with that first customer, on this design, not before.
- The output schema (2) waits for a second real shape.

## Consequences

- Plugin authors get a reviewer they can confine and an insertion point they can rely on, without a stage they could replace.
- A finding dropped by policy is still a finding ocra saw: the report says who dropped it and why, which keeps the quality numbers honest and the audit trail complete.
- The plugin interface is a 0.x contract (stability page): adding optional fields and a registration method is compatible; the first processor customer also fixes the processor's view of the change, which is the part most likely to be wrong on the first try.
