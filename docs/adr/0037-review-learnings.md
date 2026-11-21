# ADR-0037: Review learnings: files in the repository, selected before the model

- Status: accepted
- Date: 2026-11-21

## Context

Rules (`.ocra/rules.json`) say what a team always wants checked on a path, and memory (`.ocra/memory.json`, ADR-0028) says which findings it has accepted. Neither holds what the team has learned from past changes: the bug a fix commit repaired, the reason a reviewer gave when they rejected a pattern, the incident a module caused. Review tools that learn keep such lessons as retrieval data in a vendor's database, where a team cannot read, review or roll them back, and where retrieval by embeddings decides, out of sight, what a reviewer sees.

ocra needs the lessons to be reviewable like code, available to a self-hosted install with no vector store, and chosen so that a lesson that applies is almost never left out (recall), while a review that has none pays nothing.

## Decision

1. **A learning is one Markdown file in `.ocra/learnings/`,** its YAML frontmatter holding `title`, `paths` (globs), optional `symbols` and `keywords`, `critical`, an optional `source` (`kind` and `ref`, such as the pull request or commit it came from) and `created`; the body says what to check and why. The file name without `.md` is the learning's id. The files are the only source of truth: a product database may index them and count their effect, and can always be rebuilt from them.
2. **The schema and its limits live in `@open-cr-agent/cloud-contract`** (`learnings.ts`), since ocra Cloud writes the files the engine reads (ADR-0033). The contract stays Zod-only: it splits a file into frontmatter and body, and the caller parses the YAML.
3. **Learnings are read from the trusted revision,** like rules and memory: in a pull request review from its base, so a change cannot add a learning that steers its own review. A file that does not parse is skipped with a warning; it never fails the review.
4. **Selection is deterministic and runs per bundle before any model call** (`core/src/knowledge/select.ts`). A learning is a candidate when one of its `paths` matches a file of the bundle (old or new path), one of its `symbols` appears as a whole identifier in the bundle's patches, or one of its `keywords` does. Candidates rank by path match, then symbol match, then how many of their terms (keywords and title words) the patches contain, then id. A `critical` learning whose path matches is always included (at most `MAX_CRITICAL`); the rest fill up to `MAX_SELECTED` entries and `MAX_SELECTED_CHARS` characters of body.
5. **What was used is reported:** the report's `learnings` lists each selected learning with its source and the bundles it was given to, so a team can see why a reviewer said what it said, and ocra Cloud can count hits.
6. **Selection recall is measured by replay and gated in CI.** A fixture set of changes, each with the learnings that should apply, runs through the selection with no model; recall below 95% fails `npm test`.
7. **Learning bodies are data in the prompt** (`data()`, `<ocra_team_learnings>`), never instructions, however they were written.

Deferred, each with its own change: weighting candidates by their measured effect (needs the stats a source plugin collects), an index of the candidates that did not fit and a tool to read one, matching through the code graph, and the source plugins that write learnings (fix-commit miner first, then review feedback, document import, `@ocra remember`).

## Consequences

- A team reads, reviews and reverts what ocra has learned in pull requests, and a self-hosted install needs nothing beyond the repository.
- Prompts grow only by the learnings a bundle matches, within a fixed budget; the resume key (ADR-0031) changes when they do, since it hashes the prompt.
- Keyword and path matching miss a lesson stated in other words. The replay set is where such misses show up; symbol matching through the code graph is the planned remedy.
- YAML parsing is a new dependency of the CLI (`yaml`, no dependencies of its own), bounded by the contract's file size limit and with aliases off.
