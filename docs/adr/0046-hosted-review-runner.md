# ADR-0046: Hosted reviews run the CLI on the self-hosted server, as the ocra bot

- Status: accepted
- Date: 2026-11-22
- Amends: ADR-0024 (Phase 2's workers)

## Context

ocra Cloud shows reviews that a CLI or CI job uploaded; a team that has not set up CI gets none. A review platform reviews every pull request by itself when it opens or gains commits. ADR-0024 left Phase 2's workers (cloning, running ocra, isolated per job) and their platform to their own record, since they do not fit Workers. The product is first an enterprise self-hosted server (Node and Postgres in Docker, GitHub or a self-hosted GitLab), which already runs the code graph's build queue (ADR-0041 point 5).

## Decision

1. **The self-hosted server runs hosted reviews; hosted Workers do not, yet.** A deployment without a review runner answers that auto review needs one. Running them for ocra Cloud's own hosting (a container platform and its budget) is a later record.
2. **A repository is enrolled by one account.** The account that turns on auto review for a repository is the one whose key and budget pay for its reviews; the database refuses a second one (`UNIQUE` on platform, host and repository id). Its pull requests are reviewed when they open, reopen, leave draft or gain commits; drafts are not.
3. **A queue of heads, newest wins.** A webhook (GitHub's App webhook with its signature, GitLab's per-repository secret) queues the pull request's head, one job per head (`UNIQUE`), and cancels the queued jobs of its older heads. Workers claim jobs with a lease and retry a failed one a bounded number of times, as graph builds do.
4. **A job runs the released CLI, not a library call.** The worker fetches the head into a new temporary directory, runs `ocra review --pr <n> --publish` (or `--mr`) with `--no-repo-config`, its models given by `OCRA_MODEL_*` and the account's provider key, and a spend limit from the account's budget. Pull request mode already refuses to run anything from the reviewed tree (ADR-0013), so the untrusted head gets exactly the CI Action's protections. The child gets only the variables it needs, a timeout, and is killed with its process group on cancel. The directory is removed on every exit path: code is deleted after use unless the account opted into a cache.
5. **The review is posted as the ocra bot, never as a person.** On GitHub with an installation token of the deployment's GitHub App, minted per job and limited to the one repository and to the permissions a review needs; on GitLab with the bot account token the administrator configures. The comments say they come from ocra, and do not depend on any one person staying connected.
6. **The result lands like an upload.** The job's JSON report is stored for the account through the same projection as a CLI upload, with its pull request identity (ADR-0038), so the inbox and the review page show it.

## Consequences

- A team gets reviews without CI. The CLI and the Action keep working unchanged; a repository reviewed by both gets two reviews, so the console says when a repository has CI reviews too.
- Hosted reviews inherit the CLI's caps, exit codes and security tests; the server adds the clone, the queue and the bot token, each tested in ocra Cloud.
- A GitHub deployment needs its App's private key (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`) and the App's pull request webhook; a GitLab one a bot token. Neither is stored in the database.
- Hosting reviews for ocra Cloud's own users waits for the runner platform and its budget.
