---
"@open-cr-agent/code-graph": minor
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
---

### Added

- `@open-cr-agent/code-graph`: definitions and uses per file with tree-sitter (TypeScript, JavaScript, Python, Go, Rust, Java), cached by git blob id.
- `ReviewOptions.symbols` takes a `SymbolExtractor` for the impact analysis.

### Changed

- Callers count a symbol as changed when any line of its body changes, list only uses in code with the function or class they sit in, and put changed signatures first. The CLI caches what it parses in `~/.cache/ocra/symbols/` (`$OCRA_CACHE_DIR`).
