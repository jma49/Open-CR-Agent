# ADR-0028: Findings in ocra Cloud, opt-in, and memory kept in the account

- Status: accepted
- Date: 2026-10-04

## Context

ADR-0024 made the upload counts-only by default, with content opt-in. ADR-0027 put the configuration in the account. The maintainer asked (2026-10-04) that everything the CLI can do be possible in ocra Cloud, and chose content upload as an opt-in. Today the web shows counts, so it cannot show a review's findings, let a user download a report, or do what `ocra memory` does (remember a finding the team accepts so later reviews stop reporting it). `ocra metrics` counts per reviewer and over a finding's lifecycle (fixed, dismissed), which the counts upload does not carry.

## Decision

1. **Per-reviewer counts join the default upload.** Without any opt-in, a review's upload adds, per reviewer: tasks run and failed, findings by severity, and the lifecycle counts the report already has (fixed, dismissed, still open, carried over). Still numbers only. The web's Reviews page then shows what `ocra metrics` shows.
2. **Findings are uploaded only when the account turns it on.** A switch on the web's Settings page, off by default, labeled "Send findings and the code they quote to ocra Cloud" (ADR-0024's "share review content"). When on, the CLI sends per finding: fingerprint, reviewer, severity, category, verification, file path, line range, title, body, suggestion and the quoted code. Before upload it replaces secret-looking tokens (key prefixes such as `AKIA`, `ghp_`, `sk-`, PEM blocks, long high-entropy literals) with `[redacted]` in body, suggestion and code and marks the finding redacted; the server runs the same pass. This catches patterns, not every secret, and the data policy says so. Bounded on both sides: at most 200 findings, 4 KB per text field, 256 KB per review, with `truncated: true` when cut. The web renders it as plain text, addresses as text, never as HTML or raw Markdown. Turning the switch off stops new uploads and offers to delete every finding sent; counts stay. Findings follow the review counts' retention (90 days) and go with their review or the account. `--no-upload` and `OCRA_CLOUD=off` still send nothing.
3. **The web shows a review in full when it has findings**: findings by file with severity, verification and suggestion, filters, and a JSON download, `ocra-cloud/review-export` (version 2 since 2026-10-04, when the quoted code moved from `evidence` to `code` as the report names it), holding the findings in the report's `findings[]` shape and the counts. It is not a report: the report's coverage, tasks, provenance and usage were never uploaded.
4. **Memory can live in the account.** On a finding in the web, "Remember" with a reason stores `{repository hash, fingerprint, file, title, reason}` in the account, at most 500 entries per repository, kept until deleted (not subject to the 90-day retention). A signed-in review fetches the account's entries for its repository and applies them with `.ocra/memory.json`'s: suppression is the union of both sources, and a finding listed in both is reported under the repository's entry. A fingerprint is the category, the file and the normalized quoted code, so a moved file or a changed snippet raises the finding again, from either source. The report names each suppressed finding with its source, and the terminal prints how many the account's memory suppressed. Account memory applies in `--pr` and `--mr` as the account's own layer (ADR-0027) and never in a run the account did not sign in. So that one repository has one hash on all of a user's machines, the salt becomes per account when the switch is on: created on the server at first login, fetched with the session, kept beside the credentials; with the switch off the per-machine salt stays. Memory is set from the web only; `ocra memory add` keeps writing the repository's file.
5. **The data policy and the threat model change before the switch ships**: the policy states what the switch sends, the redaction's limits, that it is off by default and how to delete it; the threat model gains the cloud section ADR-0024 promised, with the upload and account-memory suppression.

## Consequences

- With the switch off, nothing changes for privacy beyond per-reviewer numbers.
- With a server-held salt the service could test guessed origin URLs against a repository's hash; with findings on, the paths already reveal more.
- A compromised service could suppress findings through account memory, a quality attack visible in the report (each suppression names its source) and bounded to repositories the account reviewed.
- Account memory is per user; a team shares memory through the repository's file, as today, until organizations (Phase 2).

## Alternatives considered

- **Findings on by default:** the richer experience, but it reverses ADR-0024's promise; rejected by the maintainer.
- **Memory only in the repository:** keeps one source, but leaves the web unable to do what the CLI does.

Reviewed with Claude Fable 5.1: accepted with the switch labeled for code, redaction before upload, a per-account salt so account memory matches across machines and the App, union memory semantics with the source in the report, `ocra memory add --cloud` dropped, a cloud export schema instead of report v1, and the threat model's cloud section.

## Implementation notes (2026-10-09)

- Per-reviewer counts carry tasks, failed tasks, findings by severity, cost, and two lifecycle counts, `fixed` and `dismissed` (`reviewerCountsSchema` in `packages/cloud-contract/src/upload.ts`). "Still open" and "carried over" from Decision 1 were not added; the review-wide counts and the findings, when shared, cover what the web shows. Adding them is a backward-compatible change to the upload schema.
- The Context's "ADR-0024 made the upload counts-only by default" describes what shipped, not ADR-0024's text; ADR-0024's implementation notes record the difference.
- **Findings also need this machine's consent.** The switch lives on the server, so the server alone could turn uploads of code on. `ocra login` records the machine's consent (`share-findings` beside the credentials) when it finds the switch on, with the user at the terminal, and says so; a review that finds the switch off removes it. A review whose account answers a salt without that record sends counts only and says how to give consent. Turning sharing on after signing in therefore takes a new `ocra login` on each machine.
