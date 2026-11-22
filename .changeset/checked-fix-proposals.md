---
"@open-cr-agent/cli": minor
"@open-cr-agent/core": minor
"@open-cr-agent/code-graph": minor
"@open-cr-agent/cloud-contract": minor
---

### Added

- `fixes: true` or `ocra review --fixes` proposes a fix for findings a local edit fixes, one `fixer` call per file, each kept only if it applies to the reviewed head, touches only the finding's lines and still parses; the report's `fixes` says why one was not kept (ADR-0058).
- `ReviewOptions.syntax` and `treeSitterSyntax()` check that a fix leaves its file parsing.
- ocra Cloud account settings can turn fixes on (`fixes` in the review settings).
- `ocra-eval run --fixes`, with fix counts in the golden summary.

### Changed

- The judge's call counts toward the spend limit.

### Fixed

- A tree-sitter parse cut off by its time budget no longer carries over into the next file's symbols.
