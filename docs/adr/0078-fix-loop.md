# ADR-0078: The fix loop: one checked commit per round, verified by the change request's own CI

- Status: proposed
- Date: 2026-11-23

## Context

After a review ocra can write a local fix for a finding (ADR-0058), write one for a stored finding on request (ADR-0077), and commit tests or doc comments (ADR-0051); ocra Cloud commits a fix on a click. Then it stops. A finding whose fix spans two files, a check that fails on the pushed commit, a conflict with the base branch and a reviewer's "rename this" each go back to the author, who returns to a change they had left. Teams now expect the tool to carry the change request the rest of the way: keep fixing until the checks pass and the open points are answered, and leave the merge to people.

The usual design is an agent with a shell in a sandbox: clone, install, run the tests, edit until they pass, push. It works because the agent can run the code. Three things keep ocra from copying it as is:

- **The security contract.** ocra runs nothing from a change request (ADR-0013 point 2), and that record already says where such work belongs: "a separate job without secrets, not in ocra".
- **The enterprise deployment.** A sandbox per deployment is the smaller cost; reproducing the project's build (internal registries, toolchains, services) inside it is the larger one, and the team's CI has already paid it.
- **The models.** An open-ended shell loop needs dependable tool calling and a large window. Inside a company the model may have neither (ADR-0070, ADR-0071).

What that field has learned does carry over, and none of it needs a shell: a prompt's "change only what is needed" is advice, so scope is a gate in code over the resulting diff; the model's output is a patch, applied by a step that holds the credential the model never sees; attempts are capped, because a fixer and a reviewer can feed each other without end; the fixer never approves or merges; only people who may push steer it; every push says what it changed and how to undo it; and a fix that needs to touch tests, dependencies or CI configuration is handed to a person rather than given more reach.

## Decision

1. **The loop is a state machine in code, and a round is one process.** `ocra mend --pr <n>` (or `--mr`) runs one round: read the state, collect the work, write edits, check them, make at most one commit, report, exit. Whoever schedules it (ocra Cloud's job queue on a webhook, a CI workflow on a finished check) starts the next round when the platform says something changed. No process waits for CI, so a round fits the runner that runs reviews (ADR-0046).

2. **Nothing from the change runs, and "green" is the platform's word.** A round's edits are verified in three steps: checks in code (point 5), a verifier call over the round's diff (point 6), then the change request's own CI on the pushed commit, which is the separate job ADR-0013 names and already has the project's environment. The loop reads the outcome of that CI; it never builds, installs or tests.

3. **Four kinds of work item, collected by code.** Each has a stable id, so attempts are counted per item.
   - `finding`: a finding of a stored review that a person with write access accepted (ocra Cloud's button, `@ocra fix` in its thread), or, when the repository sets `mend.findings: "confirmed"`, every critical finding Verify confirmed.
   - `check`: a check that failed on the current head and does not fail under the same name on the base branch's head. Its log is read through a new `VcsAdapter.checks`, the last 200 lines of at most 3 failed jobs, 20,000 characters each, as data (`prompt-text.ts`): a test can print anything.
   - `conflict`: the files `git merge-tree --write-tree` reports for the base branch merged into the head. Nothing is checked out and no driver or hook runs.
   - `request`: a comment that passes ADR-0048's rules (write access, not edited by another, not ocra's own, unanswered). One light-tier call sorts it into `edit`, `answer` or `decline`; only a small, named change is an `edit`, and the others get ADR-0048's reply and no commit.

4. **Three lanes write edits, each the smallest that can.**
   - *Local:* a finding within ADR-0058's candidate rules goes through `proposeFixes` unchanged: one completion, no tools.
   - *Agent:* everything else that is a `finding`, `check` or `request` gets a task on the `fixer` role with the review's read tools and one more, `edit` (`path`, the exact lines to replace, their replacement; or a new file's content). Edits land on an overlay of the head held in memory, which the agent's later reads see. There is no shell, no disk write and no network. One item per task, with only that item's context, so a small window holds it; the step cap, the wrap-up turn, text tool calls and the context gauge are the reviewer loop's.
   - *Conflict:* one completion per conflicted file, given the base, both sides and the lines around each conflict; it answers each conflicted region and code puts the file together, so the regions git merged cleanly cannot change.

5. **A gate in code decides what a round may commit.** An item whose edits fail any rule is dropped whole, never repaired, with the rule as its reason.
   - *Editable files:* the change's own files, the file an item names (the finding's, the commented one, a repository file in a failed log's stack frame), and at most 5 files that define or use a symbol in the lines being edited, by the code graph.
   - *Protected files, never editable:* CI and workflow configuration, `.ocra/`, guideline files, dependency manifests and lockfiles, migrations, ownership files, generated and vendored files, and every path the review's access policy refuses. `mend.protected` adds paths and removes none.
   - *Tests:* a test file is editable only when the change already touches it. A round never deletes a test or adds a skip or ignore marker (`tamper`).
   - *Size and form:* at most 10 files and 200 added lines per round; each replaced range matches the head exactly once; no unsafe code point; the patched file parses with no more errors than before (`checkFix`'s rules, per file).

6. **A verifier call reads the round's diff before the commit.** One call on the `verifier` role per item: the item, the diff of its edits and the lines around them, answering whether the edit resolves the item and adds no defect. "No" or "cannot tell" drops the item. The next review of the pushed commit is the usual one (ADR-0010); a finding it raises on lines a round wrote is an item like any other, under the caps of point 8.

7. **One commit per round, from the head the round read.** It goes through `VcsAdapter.commit` with ADR-0051's rules: the parent is that head, the update is never forced, a fork or a branch the token may not push to is `not_writable`, a branch that moved is `head_moved`. A conflict round needs a second parent (`ChangeCommit.mergeParent`). One comment per round lists each item with what was changed and why, the items left and their reasons, and the command that reverts the commit.

8. **The loop stops by rule, and says why.** The state (rounds, spend, each item's attempts, outcome and failure signature) belongs to the scheduler, is passed in (`--state`) and returned in the result; without a scheduler it lives in ocra's hidden state comment (ADR-0016).
   - *Done:* no open item and no failed check.
   - *Per item:* 2 attempts. A check counts as the same item while its signature (the failing test or first error line, normalised) is unchanged. Then `needs_human`.
   - *Per change request:* 6 rounds, and a spend limit of its own (`mend.maxCostUsd`), apart from the review's.
   - *A revert is final:* when the branch holds a revert of a round's commit, that round's items close as `reverted` and are not fixed again.
   - *A person's push wins:* `head_moved` drops the round's edits; the next round plans again and no attempt is counted.
   - *A person's word wins:* `@ocra stop`, a draft, a closed change request.

9. **What the loop never does.** Approve, merge, turn on auto-merge, force-push, push to another branch, change protection, dismiss a review, resolve a person's thread without an edit that answers it, or act on a change request from a fork or one a bot opened. Only people with write access start, steer or stop it; everything else it reads is data.

10. **Three levels per repository:** `off` (the default), `propose` (the round ends with its checked edits in the result, and a person commits them in ocra Cloud as they commit a fix today), `commit`. The account that enrolled the repository (ADR-0046) pays.

11. **The result is the contract's.** `mendResultSchema`: `outcome` (`committed`, `proposed`, `nothing`, `waiting`, `stopped`), each item with its outcome and reason, the usage, and the state to pass back. Exit codes follow `ocra generate`.

12. **It lands in three steps, each off until measured:** findings and requests first (the agent lane), then checks, then conflicts. The measure for findings is the golden cases mined from fix commits, where the author's fix is the reference; for checks, pairs of a failed and a passing head from ocra's own history.

## Consequences

- A round costs at most one light call per request, one fixer task per item and one verifier call per item; the caps bound a change request's total.
- The loop is as fast as the team's CI, and every attempt is a commit people see. The caps keep that to a few commits; `propose` keeps it to none.
- It will fix less than an agent that can run the code: it cannot reproduce a failure, only read its log. The loop says so by handing the item over instead of trying longer.
- On a branch of the repository, CI runs what a round committed with CI's own secrets. The author could already do that; the new path is hostile text in a file or a log steering an edit. The gate keeps CI configuration and manifests out of reach, the diff is bounded and read by the verifier, and the commit is visible and reverts alone. This residual risk goes on the threat-model page with the feature.
- AGENTS.md's rule that agents get no write tool is restated with the feature: an agent's edits reach an overlay in memory, and only code writes a commit.
- GitHub starts no workflow for a push made with a workflow's own token, so the loop needs the deployment's App token (ocra Cloud's bot has one) or a personal token.
- GitLab's commits API takes no second parent, so conflict rounds there need a push from the runner's clone; that is decided with step three.
- `VcsAdapter` gains `checks`; `ChangeCommit` gains `mergeParent`; the configuration gains `mend`; the manual gains a page, in both languages, with the implementation.
- An optional executor that runs a team's declared commands in a process with no key, token or network, taking a patch in and giving a log out, would shorten the loop. It is a separate record, and nothing here depends on it.

## Alternatives considered

- **An agent with a shell in a sandbox, in the engine or the runner.** The strongest fixer, and the one design that breaks ADR-0013, needs every deployment to rebuild its CI environment, and leans on the model abilities internal models most often lack. The executor above keeps the door open without the engine holding both a secret and the code.
- **A long-lived agent session that watches the change request.** It holds a process and a conversation across CI runs; a round per event needs neither, survives a restart, and its state is a record anyone can read.
- **Handing the work to an external coding agent.** The model source is one API path with no delegate mode; a second agent would bring its own tools, network and rules.
- **A free-form unified diff as the edit.** Models miscount hunks, and a diff names lines rather than content. An edit that quotes what it replaces is checked the way a fix is.
- **A branch or change request of its own for every round.** It keeps the author's branch untouched and doubles the change requests and CI runs; `propose` answers the wish to look first.
- **Reviewing each round's diff with the full reviewer set before the commit.** It pays the review twice, since the pushed commit is reviewed anyway; one verifier call per item asks the narrower question.
