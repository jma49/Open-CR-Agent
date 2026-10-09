# Open-CR-Agent

The language of a code review run: what is reviewed, by whom, how far each review got, what it found, and how people answer it.

Some wire and file formats spell a term differently and are frozen contracts: the review state's `pending` and the upload's `files.notReviewed` both mean **Unfinished file**, and the error code `BUDGET_EXHAUSTED` means the **Spend limit** was reached. Keep those spellings where the contract needs them and use the glossary's word everywhere else.

## Language

### Runs and change sets

**Run**:
One invocation of `ocra review` over one change set, from reading the change to the report.
_Avoid_: Job, execution

**Change request**:
A GitHub pull request or a GitLab merge request: the platform-neutral name for the change a review is posted to.
_Avoid_: PR or MR when both platforms are meant

**Prior review**:
The last review ocra posted on the same change request, whose state the next run reads.
_Avoid_: Previous, earlier or last review

**Full review**:
A run that reviews every selected file rather than only what changed since the prior review.
_Avoid_: Full (alone), complete review

**Session log**:
The directory where a run keeps its report and transcripts on the machine that ran it.
_Avoid_: Session (alone: also an OpenCode session and an ocra Cloud sign-in)

**Cloud session**:
The signed-in link between the CLI on one machine and an ocra Cloud account.
_Avoid_: Login, session (alone)

### Planning

**Risk tier**:
How much review a change set gets, from its size and the paths it touches: `trivial`, `lite` or `full`.
_Avoid_: Tier (alone), level

**Bundle**:
A group of related changed files reviewed together.
_Avoid_: Batch, chunk, group

**Reviewer**:
One of ocra's review agents, defined by a domain, a prompt and a scope, such as `correctness` or `security`.
_Avoid_: Reviewer for a person (that is a **Maintainer**), checker

**Cell**:
One (bundle, reviewer) slot of the review matrix, run or skipped with a reason.
_Avoid_: Job, pair, (bundle, reviewer) pair

**Sample**:
One of the independent reviews of a cell: one, or two under `--ultra`.
_Avoid_: Run, second run

**Task limit**:
The most review tasks one run may start; the matrix skips what does not fit.
_Avoid_: Max tasks, task cap

**Plan phase**:
A short model call before a review task that lists what its reviewer should check first.
_Avoid_: Plan (alone), checklist call

**Preview**:
What `ocra review --plan` prints: the selection, tiers and cells of a run, without any model call.
_Avoid_: Plan (alone), dry run

### Review work

**Review task**:
A unit of review work on one cell and one sample, usually an agent with read-only tools; results imported from a static analyzer form a synthetic task with no agent.
_Avoid_: Job, cell (that names the slot, not the work)

**Task status**:
Whether a review task's run went wrong: `completed`, `failed`, `timed_out` or `cancelled`. `completed` means nothing went wrong, not that the reviewer finished; that is its **Ending**.
_Avoid_: Result, outcome

**Attempt**:
One call of one model for a task or a completion; a failed or rate-limited attempt is followed by another on the same or the next model of the chain.
_Avoid_: Try, retry

**Done tool**:
The tool a reviewer calls to say it has finished every file of its bundle.
_Avoid_: Done signal, finish tool

**Step cap**:
The fixed number of model steps a review agent may take in one task.
_Avoid_: Step limit, 30-step limit

**Ending**:
How an attempt ended: `done` (its agent called the done tool), `step_cap` (it used every step without it), `stopped_early` (it stopped with steps left, without it) or `error`.
_Avoid_: Finish reason, exit reason, cut off

### Coverage and completeness

**Coverage status**:
What the run did for one changed file: `reviewed`, `incomplete`, `failed`, `unreviewed`, `unchanged` or `excluded`.

**Incomplete (file)**:
A file none of whose reviewers failed, and at least one of whose reviewers ended every sample without the done tool, so it was at most partly reviewed; shown to users as "partly reviewed".
_Avoid_: Cut off, truncated

**Unfinished file**:
A selected file the run did not finish (`failed`, `unreviewed` or `incomplete`): it makes the review incomplete and the next review of the change includes it.
_Avoid_: Pending file, missed file, not-reviewed file

**Incomplete review**:
A run whose result must not be read as a pass, because it left an unfinished file or a critical finding Verify could not check (exit code 3).
_Avoid_: Partial run, failed run

### Findings

**Finding**:
One issue a reviewer reports, anchored to a file and, when its quote resolves, to lines.
_Avoid_: Comment, result

**Quote**:
The lines of existing code a reviewer copies into a finding to say where it is.
_Avoid_: Snippet, evidence (evidence is the reasoning, not the code)

**Quote signature**:
A digest of the anchored file lines a finding points at, kept to tell in a later run whether that code is still there.
_Avoid_: Quote, hash

**Anchor**:
The file and lines a finding's quote resolves to, never a line number a model gave.
_Avoid_: Location, position

**Fingerprint**:
The identity of a finding across runs, from its category, file and normalized quote.
_Avoid_: Finding id (that is per run), hash

**Verification**:
Verify's answer for one finding: `confirmed`, `uncertain` or `unchecked`.
_Avoid_: Unsure, did not check (user wording only)

**Judge**:
The single model call that merges duplicate findings across reviewers, drops speculation and recalibrates severity.
_Avoid_: Aggregator, coordinator

**Verdict**:
The fixed rubric's conclusion over the final findings: `approved`, `approved_with_comments`, `minor_issues` or `significant_concerns`.
_Avoid_: Decision, score

### The review conversation

**Maintainer**:
A person entitled to answer ocra on a change request: someone with write access (GitHub) or the Developer role or higher (GitLab), other than its author.
_Avoid_: Reviewer (that is ocra's agent), approver

**Dismissal**:
A maintainer's answer that a finding on one change request is not worth fixing; it lapses if the finding comes back at a higher severity.
_Avoid_: Ignore, mute, memory

**Memory entry**:
A finding a repository or an account has chosen not to hear about again, at any severity and on any change to that repository.
_Avoid_: Accepted finding, remembered finding, dismissal

**Override**:
A maintainer's decision to let one head commit pass despite a blocking verdict, which stays as it was.
_Avoid_: Bypass, approval

### Cost and models

**Model tier**:
The class of model a step uses: `top`, `standard` or `light`.
_Avoid_: Tier (alone), size

**Chain**:
The ordered models a model tier or an agent role may use, strongest first.
_Avoid_: Fallback list, model list

**Failback**:
Moving a task or completion to the next model of its chain after a model fails or runs out of quota.
_Avoid_: Failover, fallback

**Spend limit**:
The most a run may spend on models, in US dollars.
_Avoid_: Budget, cost limit, cap

**Helper**:
The agent role for small light-model calls around the review, such as grouping files into bundles and relocating unmatched quotes.
_Avoid_: Helpers (for utility code), utility model

### Evaluation

**Golden case**:
One change with the issues a correct review must find, labeled per claim.
_Avoid_: Test case, fixture

**Golden tier**:
A named set of golden cases of growing cost: `smoke`, `full` or `adversarial`.
_Avoid_: Tier (alone), suite
