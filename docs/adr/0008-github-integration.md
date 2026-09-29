# ADR-0008: GitHub integration

- Status: accepted; pull requests from forks: [ADR-0013](0013-fork-pull-requests.md)
- Date: 2026-09-26

## Context

M3 brings ocra to pull requests. Code search needs the repository at an exact revision, which the GitHub API cannot provide (code search ignores refs), and pull request CI already has a checkout. Pull requests are also the hostile case: their diff, title, description, `AGENTS.md` and `.ocra/` files are written by the author, possibly from a fork.

## Decision

- **Code from git, conversation from the API.** `GitHubAdapter` takes the pull request's metadata, the previous review and publishing from the REST API, and delegates `getDiff`, `readFile` and `searchCode` to a code source the CLI supplies: the local git adapter on the range `base.sha..head.sha`, which is the same merge-base diff GitHub shows. The adapter package depends only on `core`; the CLI composes the two.
- **Trusted inputs come from the base revision.** In pull request mode, `AGENTS.md`, `.ocra/rules.json` and `.ocra/config.json` are read at the base commit, and repository plugins are never loaded. Credentials come from the environment (`GITHUB_TOKEN`, model keys); the workflow runs on `pull_request`, never `pull_request_target` with a checkout of the head.
- **Publishing.** Findings anchored inside the diff become inline comments in one review (`COMMENT` event); everything else goes into a single summary comment that ocra updates in place on every run, found by a hidden marker. ocra never approves. `REQUEST_CHANGES` is opt-in for the `significant_concerns` verdict. If GitHub rejects an inline position, the review is posted without inline comments and those findings move to the summary.
- **Incremental re-review.** The summary comment carries a hidden, versioned state block with each reported finding's fingerprint, title, file, severity and whether it already has an inline comment. The next run compares fingerprints: findings seen before are `unfixed` and are not commented inline again; findings that disappeared are listed as fixed. The state is untrusted input (anyone with write access can edit the comment), so it is size-limited and validated, and it only suppresses duplicate comments; it cannot hide a new finding.
- Resolving review threads (GraphQL) and "won't fix" replies are left for later.

## Consequences

- One pipeline serves local and pull request reviews; only the code source's range and the publishing differ.
- The workflow needs `contents: read` and `pull-requests: write`, and a checkout with both commits (`fetch-depth: 0`).
- The published comment format is a contract: the state block is versioned so later releases can read earlier reviews.

## Implementation notes (2026-09-27)

The decision stands; these parts of it changed or were added later:

- When GitHub rejects an inline position, no review is posted unless `REQUEST_CHANGES` is on (then it is posted without comments); the findings move to the summary.
- Thread resolution and dismissals by reviewers are implemented (ADR-0009, and #107 for which replies count).
- With `REQUEST_CHANGES` on, ocra requests changes once while the verdict blocks and dismisses its own request when it no longer does (#110).
