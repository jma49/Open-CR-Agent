---
"@open-cr-agent/cli": minor
"@open-cr-agent/cloud-contract": minor
---

### Added

- `ocra graph --cloud` starts from the code graph a self-hosted ocra Cloud server keeps of the repository, and parses only the files changed since; without one it builds the graph locally.
- `@open-cr-agent/cloud-contract` describes the server's code graph listing: `graphRepoSchema`, `graphReposAnswerSchema`, `CODE_PLATFORMS`, `GRAPH_BUILD_STATES`, `GRAPH_COMMIT_HEADER` and `MAX_GRAPH_REPOS`.
