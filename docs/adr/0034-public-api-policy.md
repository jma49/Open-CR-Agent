# ADR-0034: Each package's public API is a named list, recorded in an API report

- Status: accepted (records the decisions made on 2026-10-03)
- Date: 2026-10-09

## Context

Every published package's main entry used `export *`. About 147 runtime values left `@open-cr-agent/core` alone, though only `review()`, the plugin interface and the documented types were meant as a contract. Anything exported could be imported by a plugin or an embedder, so any internal refactor could break a caller without anyone noticing in review. ocra's own packages still need to share more than the contract.

## Decision

1. **A package's main entry (`src/index.ts`) exports a named list, never `export *`.** For core: `review()` and what it takes and returns, the report output and its schema, `parseSarifLog()`, the plugin interface, the `VcsAdapter` and `AgentRuntime` contracts, the domain types and the error model; for adapters and runtimes, their plugin and error class.
2. **What only ocra's packages share goes to `<package>/internal`** (`src/internal.ts`), which is not a contract and may change in any release. `@open-cr-agent/vcs-platform` as a whole is not a contract.
3. **API Extractor records each main entry in `etc/<package>.api.md`.** `npm run api` updates the reports; `npm run check:api`, part of `verify` and CI, fails when an entry changed and its report did not, so a change to the public API shows in review.
4. **The 0.x rule.** Before 1.0, a patch release never changes a contract; a minor release may, with a changelog entry saying how to adapt, and where it can the old form keeps working with a warning for at least one minor release. A change that can break a caller gets that entry in the same pull request (a changeset).

## Consequences

- Internal refactors stay free; a change to the contract is deliberate and visible as a diff of an `.api.md` file.
- Embedders and plugin authors have one list to read, the manual's Stability page, and one way to learn of breaking changes, the changelog.
- Every new export costs a report update; a symbol another ocra package needs goes to `/internal` rather than the contract.
