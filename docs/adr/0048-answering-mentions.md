# ADR-0048: Answering an @ocra mention in its thread

- Status: accepted
- Date: 2026-11-22

## Context

Reviewers want to ask about a change where they read it: what a function does, whether a finding still holds after a fix, what a section of the diff is for. ocra already reads comments for its own commands (`/ocra remember`, dismissals), and only from people with write access. An answer is model output rendered on the platform, and every comment an outsider can write could cost a model call or carry instructions.

## Decision

1. **A command per comment, `ocra reply`.** It names the change request and the comment (`--pr`/`--mr`, `--comment`, `--inline` for a GitHub line comment), so a webhook or a workflow on a comment event answers that one comment. It never reviews and writes no session.
2. **The conversation rules live once, in `vcs-platform`.** A comment is answered only when it is on this change request, mentions `@ocra` outside code, asks something, was written by someone with write access, was not edited by anyone else, is not ocra's own, and has not been answered: the answer carries `<!-- ocra:reply <id> -->`, which a second run finds. Anything else is a reason on stderr and exit 0, so a workflow that runs on every comment stays green. Each platform only reads the thread and posts in it: GitHub's conversation and line-comment threads, GitLab's discussions.
3. **One plain completion on the `writer` role, not an agent with tools.** The context is chosen by code: the description, the last comments of the thread, and the commented file's patch and an excerpt around the line; without a position, the files the question names, else the smallest patches. Files come from the review's selection and are read through the review's access policy, so a question cannot reach a secret or an excluded file. Everything is data (`prompt-text.ts`), the answer is capped, and it goes through the same neutralization as findings, mentions included.
4. **In the Action, the `reply` input.** It runs on `issue_comment` and `pull_request_review_comment`, takes the comment's id from the event and never its text.

## Consequences

- One standard-tier call per answered comment, bounded in input and output; nothing for comments it ignores.
- A deeper re-review of a section is still a review (`ocra review`), not a reply.
- ocra Cloud wires the same command to its webhooks.
