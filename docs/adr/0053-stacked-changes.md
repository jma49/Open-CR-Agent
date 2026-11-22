# ADR-0053: Stacked change requests

- Status: accepted
- Date: 2026-11-22

## Context

Small change requests are reviewed faster and better, by people and by ocra: a bundle that fits one reviewer's context is read in full. A feature that needs several steps is then several change requests, each based on the one below it, a stack. Keeping one by hand is mechanical work: every amend to a lower branch means rebasing every branch above it, pushing them all, and retargeting each change request when the one below merges. GitHub and GitLab both show a change request against any base branch, but neither knows it is part of a stack.

## Decision

1. **A stack is branches with parents, recorded in the clone.** `ocra stack create <branch>` branches from the current one and records, in git config, the parent (`branch.<name>.ocraParent`) and the parent's commit it was built on (`branch.<name>.ocraParentHead`). There is no stack file in the tree and no server state: the clone is the author's working state, and the change requests' base branches are what everyone else sees. The stack is the tree of recorded branches that holds the current one, rooted at the trunk (origin's default branch, else `main`).
2. **Restack replays each branch onto its parent's tip:** `git rebase --onto <parent> <parentHead> <branch>`, bottom to top, then records the new parent head. Giving the old parent head as the upstream drops the parent's commits even when they were amended or squash-merged, which a plain rebase would replay. A conflict stops the run with the branch named and the rebase left for the author to finish; running restack again skips the branches already on their parent. Nothing is force-reset.
3. **Submit pushes and opens, one change request per branch, based on its parent.** Each branch is pushed with `--force-with-lease` bound to the commit origin had, then its open change request is found by head branch, or opened (a draft with `--draft`), and its base set to the parent. Every description gets a section between `<!-- ocra:stack -->` markers listing the stack bottom to top with the current one marked; the text outside the markers is the author's and is never touched.
4. **Sync folds in what merged.** It fetches, asks the platform which branches' change requests merged, moves their children onto the merged branch's parent (the merged branch's tip becomes the children's parent head, so its commits drop out in the restack), deletes the merged local branches and restacks. It does not push: submit does, so nothing leaves the machine without the author running it.
5. **The platforms behind one port.** `StackHost` in `vcs-platform` finds a change request by head branch, opens one, and updates its base and description; `vcs-github` and `vcs-gitlab` implement it with the same credentials as `--propose` (`GITHUB_TOKEN`, `GITLAB_TOKEN`). The stack's rules (order, parents, the description section) are pure functions in the CLI; git and the platform stay at the edges.
6. **ocra Cloud reads a stack from the platform, not from the clone.** A change request whose base branch is another open change request's head is stacked on it, so stacks made by hand or by other tools show too. Merging a stack merges from the bottom: each change request, once the one below it merged, is retargeted to the trunk and merged with the same head guard as a single merge, and the run stops at the first one the platform refuses, saying why.

## Consequences

- A second clone does not know the stack until its branches are created there with `ocra stack create` or their parents recorded again; the change requests still show it.
- Branch names and refs are checked with `git check-ref-format` and passed after `--end-of-options`; tokens come only from the environment, as for `--propose`.
- A merge of a stack in ocra Cloud is a sequence of single merges, not one atomic operation: a refusal halfway leaves the lower ones merged, which is the state a person merging by hand would reach.
