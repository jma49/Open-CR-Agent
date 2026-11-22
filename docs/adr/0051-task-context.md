# ADR-0051: The linked task as review context

- Status: accepted
- Date: 2026-11-22

## Context

A reviewer sees the change and its description, not the task it was written for. Whether the change does what was asked (a missed acceptance criterion, a half-done subtask, a fix for the wrong case) is invisible without the task, and teams keep it in an issue tracker: GitHub and GitLab issues, Jira, TAPD.

Context from outside the repository is also the easiest way to bloat and pollute a prompt. The decision on external sources (2026-11-21) is that they are scoped to the task at ingestion, not searched: the change's own linked task, its parent and its subtasks, cut to fixed sizes, and nothing when no task is linked. Each source must be one switch that adds nothing when it is off, so a later ablation (with and without) can decide whether it stays.

## Decision

1. **A linked task is a domain record** (`core/src/task/`): tracker, key, URL, title, state, labels, body, its parent's title and body, and its subtasks' titles and states. Adapters convert their tracker's API into it at their boundary.
2. **The platform finds its own links.** `VcsAdapter.linkedTasks?()` returns the tasks the platform links to the change: on GitHub the pull request's closing issues (`closingIssuesReferences`: closing keywords and the issues linked in the sidebar), on GitLab the merge request's `closes_issues`; without either, an issue number at the start of the head branch's name (`123-fix-login`, the name both platforms give a branch made from an issue). One request each, parent and subtasks included where the platform has them (GitHub's sub-issues, GitLab's epic). Only issues of the reviewed repository count: a pull request may name another repository's issue, and in a fork's pull request that would carry text its author cannot read into a review posted where they can.
3. **Deterministic and bounded** (`MAX_LINKED_TASKS` 3, in the platform's order; body 4,000 characters, parent body 1,500, 10 subtasks, 10 labels). No model call decides what is included, and nothing is searched.
4. **Run-wide and untrusted.** The tasks go into every review task's prompt as `<ocra_linked_tasks>`, right after the change request and before the bundle-specific sections, so the cached prefix is shared. Every field passes through `data()`. The reviewer is told the task is what the change was meant to do: a gap between the two is a finding only when the code shows it, and the task's text is never an instruction. Verify, the judge and the walkthrough do not see it.
5. **One switch, on by default**: `linkedTasks` in `.ocra/config.json` and `--no-linked-tasks`. Off, or with nothing linked, the prompts are unchanged, and so is the resume key (ADR-0031).
6. **What was given is reported**: the report's `linkedTasks` lists each task (tracker, key, URL, title, state, labels) and whether its text was cut; absent when the adapter cannot link tasks or the switch is off, empty when it looked and found none. A failed lookup is a warning and the review goes on. ocra Cloud reads this list from the upload (`linkedTasks` in `@open-cr-agent/cloud-contract`) for its linked-issue check instead of fetching issues again: tracker, key, URL and state with every pull or merge request upload, as part of its identity (ADR-0038); title and labels only when the account shares findings (ADR-0028), redacted like them.

Planned in this order, each with its own switch and report entry:

- **Other trackers** (Jira, TAPD) through a source the user configures (an MCP server's tool, called with the key): keys found in the title, description and branch by the tracker's configured project keys, fetched under the same limits. Repository configuration can name keys but never start a server.
- **Project documents**: Markdown files the team names in configuration, read from the trusted revision, split by heading, and picked per bundle by the changed paths they name, under a fixed cap.

## Consequences

- The reviewer can check the change against its task, which is where most "does what was asked" misses show, for at most about 6,000 characters per linked task in the cached prefix.
- A task edited between two reviews changes every prompt, so a resumed run (ADR-0031) runs its tasks again.
- Issues linked only by a mention ("see #12") are not used: they are as often context as unrelated. The platform's own links are the team's statement of what the change closes.
- A token without issue read access (GitHub's `issues: read`, GitLab's `read_api`) costs a warning, not the review.
- Whether the task context earns its tokens is measured by the per-source ablation in the evaluation phase; until then it is on by default because the cost is bounded and zero without a link.
