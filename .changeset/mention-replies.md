---
"@open-cr-agent/core": minor
"@open-cr-agent/vcs-platform": minor
"@open-cr-agent/vcs-github": minor
"@open-cr-agent/vcs-gitlab": minor
"@open-cr-agent/cli": minor
---

### Added

- `ocra reply` answers a comment that mentions `@ocra` on a pull or merge request, in its thread, for people with write access, once per comment.
- The Action's `reply` input runs it on `issue_comment` and `pull_request_review_comment`.
- `VcsAdapter.mention`, and the `Mention` and `MentionRef` types.
