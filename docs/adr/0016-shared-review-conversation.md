# ADR-0016: One review conversation for every platform, GitLab second

- Status: accepted
- Date: 2026-09-30

## Context

GitLab is the next platform (roadmap M9): it is the largest gap against peers, and self-managed GitLab is where the teams that cannot send code to a hosted reviewer are. ADR-0002 kept the `VcsAdapter` contract platform-neutral so a second platform could be added as a package.

Most of `vcs-github` is not about GitHub. Its adapter holds the rules that make ocra safe to run on strangers' pull requests:

- the summary comment's state counts only when ocra last edited it;
- `/ocra override <full commit id>` counts only from an unedited comment, by someone with write access other than the author, and never from ocra's own summary;
- a finding is dismissed only by a reviewer who resolves its thread or declines it clearly;
- replies reach the judge only from reviewers, in comments nobody else edited;
- and what gets posted, and how model text is neutralized in it.

Only the API calls differ, plus GitHub's "request changes". Copying these rules into a GitLab adapter would leave two copies of access policy that drift, and AGENTS.md says to enforce policy once.

GitLab also adds a risk GitHub does not have. A comment line that starts with `/` runs as a quick action (`/merge`, `/approve`, `/close`, `/label`), with the rights of the token that posted it, also through the API (gitlab-org/gitlab#346557). ocra neutralized only `/ocra` in model text.

## Decision

1. **A new package, `@open-cr-agent/vcs-platform`, holds the conversation.** It depends only on `core`, and platform adapters depend on it and on `core`. It contains:
   - the summary and inline comment text (`render.ts`), which takes a platform's wording;
   - the review state format (`state.ts`), unchanged;
   - the retry policy for platform APIs;
   - `PlatformReview`, a `VcsAdapter` that applies every rule above over a small port, `ReviewPlatform`.

   The port covers the bot account, the change request, its comments and who last edited one, who may write, the threads, and posting (inline findings, the summary, resolving a thread). `core` stays free of presentation.
2. **`vcs-github` maps GitHub's API to the port.** "Request changes" stays GitHub's alone, inside its inline publishing, rather than in the port.
3. **Every line-leading `/` in text ocra posts is neutralized** with a zero-width space, on every platform, before GitLab support ships.
4. **ocra recognizes its own inline comments.** A finding whose thread ocra started, with a marker comment nobody else edited, is not commented again. This holds even when the summary's state is missing or untrusted. It matters on GitLab, which takes one request per inline comment, so a run that stops before writing the summary cannot be told from its state. It also stops GitHub's repeat comments after a summary is edited.
5. **One conformance suite** (`vcs-platform/src/conformance.fakes.ts`) states these rules as tests, and each platform runs it against its own fake API, in memory and over GitHub's REST and GraphQL today.
6. **GitLab, next** (`vcs-gitlab`):
   - Merge requests from the same project first. Fork merge requests are documented, not automated: their pipelines run in the fork without the parent's variables.
   - Write access means the Developer role or higher (`/members/all/:id`, inherited members included).
   - Who last edited a note comes from GraphQL `Note.lastEditedBy`. REST notes do not say, and their `updated_at` also moves when a thread is resolved.
   - The bot is the token's own user (`GET /user`).
   - The token is a project access token with the Developer role and the `api` scope. `CI_JOB_TOKEN` cannot post notes.
   - Inline comments are one discussion per finding with a position. Context lines carry both `old_line` and `new_line`, from the diff's hunks. A rejected position leaves the finding in the summary.
   - There is no "request changes": the CI job's exit code is the gate, as `fail-on-concerns` is on GitHub.

## Consequences

- One copy of the trust rules, tested per platform from one file. A third platform (Gitea, Bitbucket) maps its API and runs the same suite.
- A sixth published package, and a seventh with GitLab. npm lets a workflow publish a package with trusted publishing only once the package exists. So each new package is published once by hand, and its trusted publisher configured, before the release that first includes it (the release runbook in the maintainers' private notes).
- `@open-cr-agent/vcs-github` no longer exports the summary rendering and state. They are `@open-cr-agent/vcs-platform`'s, a change for anyone who imported them from the 0.1 package.
- GitHub's behavior is unchanged except for points 3 and 4. The existing GitHub tests pass with only their imports changed.
