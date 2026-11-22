# ADR-0051: Generating tests and doc comments as one commit on the change request

- Status: accepted
- Date: 2026-11-22

## Context

After a review, a team often wants the change to carry what it lacks: tests for the code it adds, doc comments on the declarations it adds or alters. These are optional actions, started on purpose (a button in ocra Cloud, a workflow run), not part of every review. Unlike a review, they write to the repository: to the change request's own branch, which its author and others push to, and which may be on a fork. The reviewed code is hostile, so is every model reply derived from it, and the commit lands where a person may merge it without reading it closely.

## Decision

1. **A command per action, `ocra generate tests` and `ocra generate docstrings`.** It names the change request (`--pr`/`--mr`), takes `--config` like `ocra reply`, and writes the commit itself with the token it was given, so ocra Cloud's runner calls it exactly as it calls `ocra reply`. `--dry-run` prints the edits as a unified diff and commits nothing; `--json` prints one line whose shape is the contract's `generateResultSchema` (`@open-cr-agent/cloud-contract`), so a runner records the outcome without reading prose.
2. **Plain completions on the `writer` role, one per file, not an agent with tools.** Code chooses the files: the change's source files from the review's selection (so never a secret, generated or vendored file), in a supported language, never a test, a symbolic link or a submodule, most added lines first, at most 5. Each file is read through the review's access policy and is at most 60,000 characters; everything from the change goes through `prompt-text.ts`. Every reply is checked against a Zod schema. A file whose call fails is skipped with its reason; the run fails only when every call failed.
3. **What a commit may do is enforced in code, never by the prompt.**
   - Tests only create files. The path is ocra's, from the language's convention and the files beside the source (`.test` or `.spec`, `__tests__/`, `test_*.py` or `*_test.py`, `tests/`, `_test.go`, Maven's `src/test/`), and must have no file at the head and be one an agent could read: never in `.git` or on a secret's name. The model writes only the content.
   - Doc comments only insert lines. The model names the line each comment goes after; code refuses the whole reply for a file when one position is outside the changed hunks, follows a line continued by a backslash or has no line after it, or when one block is not the language's doc comment alone (`/** … */` closed once, at its end; `//` or `///` lines; one `"""` docstring). The original file must be a subsequence of the result, which is asserted.
   - Nothing from the repository runs: the tests are never run, nothing is installed or built. The commit message says so.
4. **The commit is made from the head ocra read, or not at all.** The rules every platform shares live in `vcs-platform` (`commitToChangeRequest`, behind `VcsAdapter.commit`): the commit's parent is the head the edits were made from, each path is a normalized path inside the repository, named once. Each platform writes it in its own terms (ADR-0016): GitHub through the Git data API, then a non-forced ref update, which GitHub refuses unless it is a fast-forward; GitLab, whose commits API takes no parent, after comparing the branch's head, with each update carrying the file's last commit (GitLab refuses it once another commit changed the file) and each new file created (refused when one is there). The commit is authored by the token's account. A fork's branch, a branch the token may not push to and a branch that moved are outcomes (`not_writable`, `head_moved`), not errors.
5. **Outcomes and exit codes.** `committed`, `dry_run` and `nothing` (no file to write for, or the model added nothing) exit 0; `head_moved` and `not_writable`, where edits were made but not committed, exit 3; usage, configuration and model errors exit 2.

## Consequences

- Up to 5 standard-tier calls per run, bounded in input and output; a run with no target calls none.
- A comment is checked by its own text, not by parsing the file: inserted inside a multi-line string literal, it would become part of the string. It can only land in the changed lines, and the commit is a separate commit a reviewer reads, and can revert, on its own.
- The generated tests may fail or not compile, since nothing runs them; the change request's own CI runs them on the new commit.
- A fork's change request gets no commit, even where the platform would let a maintainer push to it.
- The `nothing` outcome's reason lists each skipped file, so a runner can say why without a second run.
