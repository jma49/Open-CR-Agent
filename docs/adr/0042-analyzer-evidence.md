# ADR-0042: Analyzer results as evidence for the reviewers

- Status: accepted
- Date: 2026-11-21

## Context

ADR-0019 brings an analyzer's SARIF log into a review as findings: each result on the change is a finding of a synthetic task, verified and judged like a reviewer's. That suits a tool whose results a team already acts on, but most linters and SAST rules are noisy: a result on the change is often a false positive, a style point, or right but not this change's fault. Imported as findings, each costs a verification call and a comment the judge has to argue away.

The other way tools feed a model is as context: the reviewer sees the results next to the code, confirms the ones that hold, and reports them in its own words, with the change's intent in view. Whether that improves a review, and by how much, has to be measured per source (with and without), so the source must be one switch that adds nothing when it is off.

## Decision

1. **A second, separate input: `--sarif-evidence <file>`** (repeatable; `ReviewOptions.sarifEvidence`). `--import-sarif` keeps ADR-0019's meaning. The same log may be passed to both. ocra still runs no analyzer.
2. **Results on and near the change are kept**: on a reviewed file, on a hunk's new-side lines or within `EVIDENCE_MARGIN_LINES` (10) of one, since a warning just outside a diff is often what the change makes reachable. Parsing, paths and bounds are ADR-0019's; a result two logs repeat (tool, rule, file, line) is kept once.
3. **Selection is deterministic and runs per bundle before any model call** (`core/src/sarif/evidence.ts`): on the change before near it, then by severity, security-tagged first (the result's or rule's `properties.tags`, as code scanning reads them), then by file and line; at most `MAX_EVIDENCE_PER_BUNDLE` (20) per bundle, each message cut to 300 characters. Every task of the bundle sees the results on its own files; the judge merges what two reviewers report of the same result.
4. **Results are data in the prompt** (`<ocra_analyzer_results>`, after the files, with the bundle-specific sections): one line each, file and lines, tool, rule, severity, whether security-tagged, and on or near the change. The reviewer is told a result is a lead to confirm in the code, to report it only when it is in its focus and the change introduces or worsens it, and to name the tool and rule in the finding's evidence.
5. **A result is never a finding by itself.** What a reviewer reports from one is a reviewer's finding: Verify, the judge, memory and the verdict treat it as any other.
6. **What was given is reported**: the report's `analyzerEvidence` lists each tool with its version, the number of results given and the bundles that got them; a warning counts what was left out (away from the change, over the limit, unreadable).

## Consequences

- A team can hand ocra a noisy linter without each result becoming a comment; the reviewer filters it, at the price of a result it overlooks being lost, which `--import-sarif` would have kept.
- Prompts grow by at most 20 short lines per bundle, only when a log is given; with none the prompts, and so the resume key (ADR-0031), are unchanged. The ablation (with and without the flag) needs nothing else.
- Every reviewer of a bundle reads every result on its files. Routing results by kind (security to the security reviewer) would cut tokens; it waits for the ablation to show the cost matters.
- Verify does not see the analyzer's result a finding cites; it checks the finding against the code as always.
