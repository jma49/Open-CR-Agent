# ADR-0068: Reviewers that pack neighbouring bundles

- Status: accepted
- Date: 2026-11-23

## Context

Grouping (ADR-0007) cuts a change into bundles of related files, at most 10 files and 120,000 characters of diff each. Many bundles of a real change are far smaller: one or two files. The matrix starts one task per bundle and reviewer, and every task repeats the reviewer's instructions, rules, guidelines and its own exploration of the code around the files.

Correctness needs the bundle boundaries: its findings are about how the files of a bundle fit together. The security and performance reviewers mostly report something that sits in one file (an unchecked input, a query in a loop) and read neighbouring code with their tools anyway. ADR-0065 took the docs and agents-md reviewers off the bundles altogether; these two still benefit from related files arriving together, just not from small tasks.

Measured with `ocra-eval perf` (ADR-0061, scripted model) on two real changes:

| Change | Tasks | Model requests | Input tokens | Plan calls |
|---|---|---|---|---|
| 27 files, before | 28 | 146 | 1.27M | 5 |
| 27 files, after | 17 | 100 | 0.95M | 7 |
| 42 files, before | 49 | 256 | 2.90M | 5 |
| 42 files, after | 29 | 170 | 2.28M | 11 |

## Decision

1. **`ReviewerScope.span` may be `"packed"`.** Bundle by bundle the matrix applies tier, ignored files and the off switch as before, then puts what is left into the reviewer's open pack while the pack stays within the bundle size limits; otherwise it closes the pack as one task and opens the next.
2. **Packs follow run order and never mix sensitive and other bundles,** so sensitive paths still come first and get tasks of their own (ADR-0049).
3. **A pack of one bundle keeps that bundle's label;** a larger pack is labelled by its bundles' labels joined with ` + `, and its task id numbers it by its first bundle.
4. **The security and performance reviewers pack.** Their prompts are unchanged.

## Consequences

- A change of many small bundles costs about a third fewer tasks and model requests for these reviewers; a change of full bundles is unchanged.
- A pack of five files or more gets a plan call (ADR-0066), so plan calls rise while review tasks fall.
- A task covers up to 10 files within the same step cap. Whether these reviewers find as much is what the golden comparison on large cases linked in the pull request answers.
- Plugins can set `span: "packed"` on their own reviewers.
