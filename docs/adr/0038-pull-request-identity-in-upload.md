# ADR-0038: A pull or merge request's review names it in the upload

- Status: accepted
- Date: 2026-11-21
- Amends: ADR-0028

## Context

ADR-0024 and ADR-0028 send the repository as a salted hash, so ocra Cloud groups a repository's reviews without learning which it is. ocra Cloud now connects an account's GitHub and GitLab and lists their pull and merge requests; to show a review's verdict on the pull request it belongs to, it has to know which one that was. Hosted review tools keep repository and pull request metadata and protect the code: they read the names from the platform they are installed on and do not keep source. The maintainer chose that practice on 2026-11-21.

## Decision

1. **A `--pr` or `--mr` review adds `pullRequest` to its upload:** the repository as `normaliseRemote` names it (`https://host/owner/repo`), the number (a merge request's iid) and the head commit. A local review sends none. A field the server cannot read is dropped and the counts kept.
2. **Code stays where ADR-0028 put it.** Paths, titles, finding text and code go only when the account shares findings, after redaction. `repoHash` stays, so reviews still group with local ones and with the account's memory. `--no-upload` and `OCRA_CLOUD=off` still send nothing.
3. **`normaliseRemote` moves to `@open-cr-agent/cloud-contract`,** so ocra Cloud names a connected repository exactly as the CLI does.

## Consequences

- For pull and merge requests, the service learns which repository and pull request a review was; it already knows them through the platform connection. Local reviews are as private as before.
- ocra Cloud can match an upload to a listed pull request without hashing every connected repository.

## Alternatives considered

- **The number and head commit next to the hash only:** ocra Cloud would have to hash each connected repository with the account's salt to find a match, and the account's connection already names them; rejected.
- **Nothing:** the web could not show a review on its pull request.
