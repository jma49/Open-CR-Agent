# ADR-0041: The code graph of a revision, updated by blob and built where the code is

- Status: accepted
- Date: 2026-11-21
- Amends: ADR-0039 point 5

## Context

ADR-0039 parses, during each review, the bundle's files and the files a literal search names as candidate callers. A server that reviews a repository many times a day repeats that search and those reads on every review. The decided direction is a graph kept on the server and updated on each push. The engine must provide it so that ocra Cloud, a self-hosted server and CI can all build it. The hosts differ: one has a checkout and git, another only a platform's API (GitHub's trees and blobs, GitLab's or TGit's repository tree), and hosted Workers have neither git nor a file system.

## Decision

1. **The graph is a revision's symbols keyed by blob.** For each source file it stores the path, and under `<language>:<blob id>` the file's definitions and use lines (ADR-0039's per-file symbols). It holds names, kinds and line numbers, never code.
2. **An update parses only new blobs.** `updateGraph(previous, tree, readBlob, options)` (`@open-cr-agent/code-graph`) takes the previous graph, the revision's tree as a list of paths and blob ids, and a blob reader. It reads and parses only the blobs the previous graph lacks. It does no git, file or network I/O, so each host supplies the tree and the reads. Reads run with bounded concurrency and stop on an abort signal. A blob that is too large, unreadable, not UTF-8 or not parsed is skipped and recorded, never fatal, and is tried again on the next update. A graph made by another parser version is reused for nothing.
3. **A versioned, deterministic file.** `serializeGraph` writes JSON with `format: 1`, the parser version and the revision, sorted by path and key, so stored graphs dedupe and diff. `parseGraph` refuses an unknown format. A host stores the file as opaque bytes; only the engine reads it, so its shape lives in `code-graph`, not in `cloud-contract`.
4. **Reviews take callers from it by name.** `graphReferences(graph)` implements core's `ReferenceIndex`: the uses of a name in every other file of the revision, when the graph knows the file defines it. Stale lines are dropped, as for SCIP (ADR-0039 point 5). The CLI chains the indexes: `--scip` first (resolved), then `--graph` (matched), then the search.
5. **Built from trusted revisions only.** `ocra graph --out <file> [--rev <commit>]` builds or updates a graph from git objects (`ls-tree`, raw `cat-file blob`, so no filter or textconv runs). A server builds the graph after pushes to the main branch, never from a pull request's head.

## Consequences

- A review with a graph needs no search for symbols the graph knows. A file added after the graph's revision is not in it, so its callers are searched for.
- A cold build reads every source file once: in a cloud container, with one `git cat-file` per blob, 3.8 s for this repository's 625 files and 18 s for 2,117 files. An update with nothing changed takes 57 ms and 385 ms. A platform host pays one blob request per changed file.
- Same-named symbols still share callers; a SCIP index remains the way to keep them apart.
- The engine's grammars are about 6 MB of WASM, loaded per language on first use, which matters if hosted Workers ever build graphs.
- Whether a stored graph counts as kept code under ocra Cloud's code-handling setting is a product decision, made with the server work.
