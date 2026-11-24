---
"@open-cr-agent/cli": minor
"@open-cr-agent/core": minor
"@open-cr-agent/cloud-contract": minor
"@open-cr-agent/vcs-platform": minor
"@open-cr-agent/vcs-github": minor
"@open-cr-agent/vcs-gitlab": minor
"@open-cr-agent/vcs-local": minor
---

### Added

- `ocra mend --conflicts` first resolves the conflicts of merging the base branch into the head of a pull or merge request: the fixer answers each conflicted region, code writes the file, and a verifier call checks it. All conflicted files are resolved or nothing is written.
- At `--level propose` each conflicted file's resolved content is in the result (`resolved`, with `mergeParent`); at `--level commit` the round pushes one merge commit from the local clone, never forced and never a rebase.
- The item reason `conflicts`, for findings that wait behind a conflict and for files left when the merge is not complete.
- `VcsAdapter.conflicts`, `ChangeConflicts`, `ConflictedFile` and `ChangeCommit.mergeParent` in `@open-cr-agent/core`; `ReviewPlatform.baseHead`, `pushTarget` and `MergeSource` in `@open-cr-agent/vcs-platform`.
