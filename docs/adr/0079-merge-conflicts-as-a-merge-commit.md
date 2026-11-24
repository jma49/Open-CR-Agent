# ADR-0079: Merge conflicts are answered by region and written back as a merge commit

- Status: accepted
- Date: 2026-11-24

## Context

ADR-0078 names four kinds of work item for the fix loop. Findings and failed checks are built; this record settles the third, a change request that no longer merges into its base branch. Until it is resolved the platform runs no merge check, often no CI, and every other item waits behind it.

ADR-0078 already fixed how a conflict is read (`git merge-tree --write-tree`, nothing checked out) and answered (one completion per conflicted file, region by region, with code putting the file together). It left open how the result reaches the branch. There are two ways, and they differ in what they do to the author's branch:

- **A merge commit.** The base branch is merged into the head: one new commit with both parents on top of what is there. The author's commits keep their ids, review comments keep their anchors, the push is an ordinary one, and `git reset --hard <old head>` undoes it locally. The branch's history gains a merge.
- **A rebase.** The author's commits are replayed on the base branch and the branch is force-pushed. History stays linear; every commit id changes, each replayed commit can conflict again and needs its own answer, a collaborator's local branch diverges, and a force-push by a tool is the one write that can lose someone's work.

The platforms' commit APIs do not help with either. GitHub's Git Data API can write a commit with two parents, but its tree must be built from blobs the API uploads, and the merged tree of a large change holds thousands of entries beyond the conflicted files; GitLab's commits API cannot name a second parent at all. The runner that executes a round already has a clone with both commits in it.

## Decision

1. **A conflict round stands alone.** With `--conflicts`, a round first asks `VcsAdapter.conflicts(headSha)`. When the base branch merges cleanly, the round goes on as if the flag were absent. When it does not, the round works on the conflicts only: findings and checks of that round are listed as `deferred` with the reason `conflicts` and use no attempt, since an edit made at a head that is about to gain a merge would be composed against lines the merge may move.

2. **Conflicts are read in the clone, from the object store.** `git merge-tree --write-tree -z --no-messages <head> <base>` names the conflicted paths and their stages. For each path with a text conflict on all three stages, `git merge-file -p --diff3` over the three blobs gives the file with markers, at a marker size one longer than any marker-like line in it, so a file that already holds `<<<<<<<` cannot be misread. No working tree is touched and no hook, merge driver, filter or attribute of the repository runs. A path that was deleted, renamed, is binary, a symlink or a submodule on a side is not a text conflict: it is reported, closes for a person (`needs_human`, `not_candidate`), and the round writes nothing.

3. **The model answers regions; code writes files.** Code splits the marked file into the lines git merged and the conflicted regions. One call on the `fixer` role gets, per region, the base text, both sides and 20 lines around it, as data, and answers each region by number or declines. Code puts the answers between the merged lines, so no line git merged cleanly can change. The answer is refused when it leaves a marker, holds a control or bidirectional character, grows a region far past both sides, or makes the file parse worse than the head's copy. One call on the `verifier` role then reads each region with its answer and must say that both sides' intent is kept; "unsure" refuses. A round takes at most 5 files, 8 regions a file and 120 lines a region; more goes to a person (`too_large`). The gate's protected paths apply: a conflict in a workflow file or a dependency manifest is a person's.

4. **All or nothing.** A merge commit needs every conflicted file. When any file is refused, declined or left to a person, nothing is written, the files not yet tried are not sent to a model, and the resolved ones are not kept: the items say why, and the next round starts from the merge as it then is.

5. **The result is a merge commit, never a rebase.** At `--level commit` the adapter writes one commit whose parents are the head the round read and the base branch's commit it merged, whose tree is `merge-tree`'s clean result with the conflicted files replaced by their resolved content. The tree and the commit are made with plumbing against a temporary index (`read-tree`, `hash-object -w`, `update-index --cacheinfo`, `write-tree`, `commit-tree`), so the working tree, the clone's index and its `HEAD` are untouched.

6. **It is pushed from the runner's clone, without force.** `git push <remote> <sha>:refs/heads/<branch>`, with hooks off and with only the credential variables a fetch already gets. There is no `--force` and no `+` in the refspec anywhere in the code path, so a branch that moved is refused by the remote and answers `head_moved`; any other refusal (a protected branch, a token without write access, a fork) answers `not_writable`. The branch name comes from the platform's record of the change request and must be a plain branch name. This is the first push ocra makes with git instead of a platform API; it carries nothing a model wrote except the resolved files, which passed point 3.

7. **Off unless the repository says so.** `--level propose`, the default, ends with each resolved file's whole content in the result (`resolved`) and the base commit it merged (`mergeParent`), for a person to commit. A scheduler passes `--level commit` with `--conflicts` only for a repository whose owner turned that on; ocra Cloud keeps it as a per-repository switch, off by default.

8. **One contract for both platforms.** `ReviewPlatform` gains `baseHead()` and `pushTarget()` (the branch, and the author identity of the token's account); `PlatformReview` does the rest through a `MergeSource` the CLI makes from the local clone. GitHub and GitLab differ only in those two reads.

## Consequences

- A conflicted change request can be brought back to a state where its CI runs and the rest of the loop continues, with one visible commit and no rewritten history.
- `--level commit` with `--conflicts` needs a clone with a remote that accepts the token, which the review runner has; a caller without one gets `not_writable` and loses nothing.
- Repositories that require linear history on change request branches will not turn the switch on, and read the proposed resolution instead. A rebase mode is not planned: its force-push is the risk this record declines.
- The merge commit runs the change's CI as any push does. On a branch of the repository that CI has its secrets, as it has for the author's own merge; the threat model says so.
- The round's caps count a conflicted file as an item: 2 attempts while the conflict is the same text, then a person.

## Alternatives considered

- **Rebase and force-push** (with a lease): rejected for the reasons in Context; the lease narrows the race and does not make collaborators' clones whole.
- **The platform's "update branch" API:** it merges only when there is no conflict, which is the case that needs no model.
- **Building the merge tree through the platform's API:** thousands of tree entries per round for a large change on GitHub, impossible on GitLab.
- **Keeping the resolved files when some are refused, as a partial commit:** a commit with markers or half a merge is worse than none.
