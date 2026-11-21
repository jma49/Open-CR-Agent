---
"@open-cr-agent/cli": minor
"@open-cr-agent/vcs-github": minor
"@open-cr-agent/vcs-platform": minor
---

### Added

- `ocra learn mine --propose` opens the kept learnings as a GitHub pull request, set to merge once its checks pass; `learnings.requireReview: true` in `.ocra/config.json` leaves it for a person (ADR-0040).
- `proposeOnGitHub` (`vcs-github`) and the `FileProposal` and `ProposedChange` types (`vcs-platform`).
