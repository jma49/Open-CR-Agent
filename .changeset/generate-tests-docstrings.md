---
"@open-cr-agent/core": minor
"@open-cr-agent/cli": minor
"@open-cr-agent/cloud-contract": minor
"@open-cr-agent/vcs-platform": minor
"@open-cr-agent/vcs-github": minor
"@open-cr-agent/vcs-gitlab": minor
"@open-cr-agent/vcs-local": patch
---

### Added

- `ocra generate tests` and `ocra generate docstrings` write one commit on a pull or merge request's branch: new test files beside the changed sources, or doc comments inserted in the changed lines, one writer call per file (at most 5); `--dry-run` prints the edits as a diff, `--json` prints the outcome, and a moved or fork branch exits 3 without a commit.
- `VcsAdapter.commit` and `VcsAdapter.listFiles`, and the GitHub and GitLab adapters' commit on the change request's branch, made only on top of the head ocra read.
- `@open-cr-agent/cloud-contract` describes `ocra generate --json`'s line: `generateResultSchema`, `GENERATE_KINDS`, `GENERATE_OUTCOMES` and `MAX_GENERATED_FILES`.

### Fixed

- The local adapter's `listFiles` lists the repository's root directory instead of nothing.
