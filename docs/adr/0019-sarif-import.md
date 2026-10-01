# ADR-0019: External findings enter as SARIF; ocra runs no analyzer

- Status: accepted
- Date: 2026-10-01

## Context

The roadmap's M10 names analyzers (static analysis tools such as Semgrep and CodeQL) as the first finding source that is not a model, and ADR-0018 says they enter through the one `Finding` model, mapped once. Two questions were open: whether ocra runs the tool, and what the contract is.

Running tools inside a review widens the attack surface ocra is built to keep small. In pull request mode nothing from the reviewed tree may run (ADR-0013), and a tool's own configuration, rules and plugins come from that tree; an agent that could start processes would have the same problem. Every tool in this class already writes SARIF 2.1.0, the format code scanning reads and `--format sarif` writes.

## Decision

1. **ocra runs no analyzer.** The CI job runs the tool and hands its SARIF log to ocra: `ocra review --import-sarif <file>` (repeatable). A log is untrusted input like a diff: bounded in size, validated against a Zod subset of SARIF 2.1.0, its text neutralized at every sink like a model's.
2. **One synthetic task per run in the log**, `sarif-<tool>-<n>`, with the tool's slug as its reviewer, `bundle: "sarif"`, zero usage and the files it reported on. Findings carry `provenance.task` naming it, so a report reads per tool the way it reads per model.
3. **Only results on the change are kept**: on a selected file, on lines inside a hunk's new-side window. The rest of a whole-repository scan is not this change's to answer for; what was left out is counted in a warning. At most 200 results per run.
4. **The mapping is the inverse of `--format sarif`.** `error` is `critical`, `warning` is `warning`, `note` and `none` are `suggestion`, taken from the result, else from the rule's default; the title is the rule's short description, name or id; the body is the message, the rule's full description and a line naming the tool, version, rule and help URI. The category and reviewer are the tool's slug, so the fingerprint is stable across runs of the tool.
5. **The lines are a hint, the quote decides.** The result's snippet, or the file's lines at head, become `existingCode`, and the same anchoring as for a model's finding places the comment; a quote that does not match stays file-level. No relocation call is paid for a tool's result.
6. **From there on, a tool's finding is a finding.** Memory, dismissals and the previous review filter it; Verify checks it against the diff and the judge weighs it with the reviewers' findings, which is where a tool's duplicate of a reviewer's finding is merged. The verdict counts it like any other.
7. Only repository-relative paths under the source root (`uriBaseId` absent or `%SRCROOT%`) are accepted; absolute paths, other bases, schemes and parent segments are left out and counted.

## Consequences

- A team's existing Semgrep or CodeQL job feeds ocra with one flag; ocra's threat model does not change, since no process starts and no configuration from the tree is read.
- Verification and judging spend model calls on a tool's findings too; the spend limit covers them. A tool with many results on a large change costs accordingly, and is capped per run.
- A result the tool placed on unchanged lines does not appear, even when the change caused it elsewhere; that is the price of reviewing the change and not the repository.
- The format is tested against a log Semgrep 1.178.0 wrote (`packages/core/src/sarif/__fixtures__`); other tools' logs follow the same standard but have not been run through it.
- A later Analyzer plugin that produces findings in-process would map to the same candidates; it is not built until a second real use case appears.
