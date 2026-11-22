# ADR-0045: Learnings on a crowded path rank by the code the change touches

- Status: accepted
- Date: 2026-11-22

## Context

ADR-0044 leaves one limit: when many learnings share a path and the patch holds none of their symbols or keywords, they tie and the id decides, so the one that applies can fall past the listing. The patch shows only the changed lines and a little context; the function it changes often calls the symbol a learning names a few lines away (`client.release()` at the end of a function whose query the change edits).

## Decision

Amends ADR-0044 point 4.

1. **When the limits leave a candidate out of a bundle's selection,** and a `SymbolExtractor` (the code graph's tree-sitter parser) is given, ocra reads the bundle's files at the revision under review and takes the text of the innermost definitions the change touches (`changedCode` in `core/src/review/impact.ts`, at most 50,000 characters per bundle). Bundles where every candidate fits are not read.
2. **That code only ranks learnings whose path matches:** one whose symbol or keyword appears there ranks below a path backed by the patch and above a symbol named elsewhere. It never makes a learning a candidate, so the limits and the token cost are unchanged.
3. `--plan` uses the same parser, so the plan shows the learnings the run gives.

## Consequences

- On the replay where each path holds ten learnings, given recall goes from 82% to 87% with the three cases whose changed function names the learning's symbol; outside crowded bundles nothing changes and nothing is read.
- A change with no definitions around it (a Dockerfile, a pure rename) still ties by id.
- Callers of the changed symbols are not used: they would add candidates on other paths, and so tokens; that is for the per-source ablation in the eval phase.
