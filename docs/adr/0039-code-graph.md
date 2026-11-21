# ADR-0039: Code graph: tree-sitter symbols per file, an optional SCIP index for precise callers

- Status: accepted
- Date: 2026-11-21

## Context

The impact analysis (`review/impact.ts`) shows reviewers where the rest of the repository uses the symbols a bundle changes. It matched definition patterns on changed lines, so a change inside a function body did not count that function as changed. Its callers came from a whole-word search, which also matched comments, strings and unrelated symbols of the same name.

A code graph can be built three ways:

- **Compiler-based indexes (SCIP, LSIF)** resolve every reference exactly, but they need the project's build: its toolchain, dependencies and often generated code. An enterprise repository rarely has an index, and building one for each pull request costs minutes and would run code from the reviewed tree, which pull request reviews must never do.
- **Tree-sitter per file** needs no build and parses about 1 to 3 ms a file. Each file is parsed on its own (as in GitHub's stack graphs), so a file's result depends only on its content and can be cached by content. Names are matched, not resolved.
- **Embeddings** cost an index service and give up determinism. Review tools that tried them moved back to search plus a graph.

## Decision

1. **Tree-sitter is the default.** `@open-cr-agent/code-graph` implements core's `SymbolExtractor` port with tree-sitter's WASM build (no native compilation, no install scripts, a pinned version). For each file it returns its definitions with their line ranges, and the lines each identifier occurs on outside comments and strings. It covers TypeScript, JavaScript, Python, Go, Rust and Java. Other languages fall back to the definition patterns.
2. **Work is lazy and per file.** A review parses only the bundle's files and the files a literal search names as candidates for a changed symbol's callers, never the whole repository. A parse and its queries give up after a second.
3. **The cache key is the content.** Entries are keyed by the file's git blob id, the language and a hash of the queries and grammar version, so an entry never goes stale and needs no invalidation. The same cache can serve local runs (`~/.cache/ocra/symbols`), CI jobs (`$OCRA_CACHE_DIR` kept between runs) and a server, which can fill it from a tree listing without reading unchanged files. A corrupt entry reads as a miss.
4. **Recall over precision.** A symbol counts as changed when any line of its body changes. Changed signatures are ranked first. Names are matched, not resolved, and Verify and the judge filter the noise.
5. **SCIP is opt-in and consumed, never built.** Core's `ReferenceIndex` port answers "the uses of the symbol named N that file F defines". `scipReferences` reads an index the user already has (`ocra review --scip <file>`). The index describes the revision it was built from: a use whose line no longer names the symbol is dropped, and a symbol the index does not know falls back to tree-sitter. ocra never generates an index for a pull request. A server may generate one in the background after merges to the main branch and cache it per commit.

## Consequences

- Callers now include changes to function bodies and leave out comment and string mentions, and each shows the definition it sits in.
- Same-named symbols still share callers unless a SCIP index is given.
- Adding a language means adding a grammar and two queries, with a test.
- Whether more callers raise recall is unmeasured until the next evaluation round, which compares runs with and without them.
