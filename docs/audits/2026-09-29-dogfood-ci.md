# Dogfood CI audit, 2026-09-29

This audits the dogfooding of ocra's Action on Vertex AI before anything is switched on:
- #243: `.github/workflows/ocra-dogfood.yml`, a reusable workflow with a budget guard, keyless auth, the Action at v0.1.1 and a cost recorder;
- #243: `.github/workflows/ocra-review.yml`, ocra's caller;
- `.gitignore` and `docs/pitfalls.md`;
- the maintainer's uncommitted setup: the Google Cloud script, the caller for the other repositories, and the merge script that now accepts skipped checks.

Once the setup runs, every same-repository pull request in ocra spends real credit, and the maintainer's floor is hard: stop at $100 of credit left, which leaves $60 for dogfooding. The questions were:
- whether anything a pull request controls can reach the credential or its token;
- whether the budget holds against pull requests, cancellations and failures;
- whether the setup is least privilege and correct.

No model was called, no setup command ran, and no Google Cloud or repository setting changed.

Severity: **P0** exploitable or wrong in normal use · **P1** real weakness under realistic conditions · **P2** hygiene.

**Verdict: safe to run the setup script** once this pull request and the next one (the caller at `@main`) are merged, with the revised `.local/dogfood-setup.sh`. There is one P1, fixed here.

## Findings

| # | Finding | Confirmed by | Sev | Resolution |
|---|---|---|---|---|
| D1 | **A same-repository pull request could spend credit without the guard.** For `pull_request` events GitHub loads the caller, and a reusable workflow it calls with `./`, from `refs/pull/N/merge`. The identity provider accepted `ocra-dogfood.yml@` at any ref. The budget, the per-run cap and the daily allowance were the caller's inputs, and the switch was a condition in the caller. So a branch that edits either file could raise the budget, drop the guard, or run any command with a Vertex token. Only people with write access can open such a branch, but that includes the agents working under the maintainer's account, which edit workflows in pull requests as a matter of course. A mistaken edit to the guard would have spent credit before anyone reviewed it. | GitHub's OIDC claims (`job_workflow_ref` names the ref the workflow was loaded from); the workflow files | P1 | The called workflow takes no inputs. It reads the switch and the budget from the caller's repository variables. The cap and the daily allowance are constants in the file. It checks the switch, forks and Dependabot itself. The caller calls it at `@main` (the next pull request, which needs this one on `main` first). The setup script's condition requires `job_workflow_ref == 'jma49/Open-CR-Agent/.github/workflows/ocra-dogfood.yml@refs/heads/main'`. Tests fail against #243's workflow. Still open to someone with write access acting on purpose: deleting ledger artifacts with a workflow of their own that holds `actions: write`, or changing the variables. The Cloud budget alert is the backstop for that |
| D2 | **`roles/aiplatform.user` is far more than calling a model.** It lets the credential create Vertex resources, such as training jobs and endpoints, that keep billing after the token expires. A leaked hour-long token could then spend past any ledger. | Google's role description; `generateContent` needs `aiplatform.endpoints.predict` | P2 | The setup script creates the project role `ocraVertexPredict` with only `aiplatform.endpoints.predict` and binds that. Not yet proven by a live call: if Vertex asks for another permission, the first review fails with `PERMISSION_DENIED` naming it, and it is added to the role |
| D3 | **Spend could go unrecorded.** A job that died between the review and the ledger upload left no entry, for example when the runner was lost or the artifact service failed. | The workflow | P2 | A reservation `ocra-cost-<run>-<attempt>-r<cents>` of 1.5× the cap is uploaded before authentication, and the job stops if it can't be uploaded. The guard counts a review by its `c` entry, and by its reservation while that entry is missing |
| D4 | **The switch, and the fork and Dependabot checks, lived only in the caller,** which a pull request can edit. | The workflow | P2 | Also checked in the called workflow's job condition; the switch is checked in the guard too. Part of D1 |
| D5 | **The identity provider named repositories only.** If the account were ever renamed, a new account under the old name could hold `jma49/…`. | Google's guidance on immutable claims | P2 | The condition also requires `repository_owner_id` equal to the account's numeric id, which the script looks up |
| D6 | **A public repository's job log would show the Vertex project ID and number, and the service account.** Both the `with:` inputs of the auth step and the step's `env` are printed with their values. The maintainer keeps project IDs out of public places. | GitHub's job logs | P2 | The provider, the service account and the project are repository secrets, which logs mask, passed explicitly by the caller. The switch and the budget stay variables |
| D7 | **The merge script accepted `skipping` for every check.** A required job skipped by a job-level `if` that evaluated false would have merged. | `.local/merge-when-green.sh` | P2 | `verify` and `packages` must pass; only other checks may be skipped (`.local/`, not committed) |
| D8 | **The daily allowance is a start threshold, not a cap.** A review starts while the day's spend is under $2, so a day can end near $2 plus one review. | The workflow | P2 | Accepted. It paces spending; the budget check bounds it |

## Worst case against the floor

A review starts only when `spent + $3` fits the repository's share, and only one runs at a time in each repository. The job-level concurrency group is in the called workflow at `main`, so a pull request can't change it.

So each repository ends at most `max(0, last review − $3)` above its share. ocra's cap is soft: review tasks started before 80% of $2 still finish, so a review can end above $3. A review whose record is lost counts its $3 reservation.

- With ocra alone ($24), spending stays near $25.
- With all four repositories ($60), four final reviews at $4 each would reach $64, leaving about $102.
- The Cloud budget alerts at $180 and $200 of gross spend back this up. They lag by hours.

## Checked and sound

- **The credentials file.**
  - `google-github-actions/auth` v3.0.0 writes `$GITHUB_WORKSPACE/gha-creds-*.json`. Until its post step deletes the file, it holds the job's OIDC request token (`credential_source.headers.Authorization`).
  - ocra's `--pr` mode reads with `git cat-file blob <head>:<path>` and searches with `git grep … <head>`, so an untracked file can't be reached, and `**/gha-creds-*.json` is in `SECRET_PATTERNS` besides.
  - Checkout runs before auth, with `persist-credentials: false`.
  - Nothing uploads the workspace; the ledger files are in `$RUNNER_TEMP`.
- **What OpenCode gets.** OpenCode receives only allowlisted variables: nothing under `ACTIONS_`, `GITHUB_` or `RUNNER_`, and for `google-vertex` only `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_*` and `GOOGLE_VERTEX_*`. Project configuration is disabled, and the configuration and data directories are isolated. So an `opencode.json` in a pull request can't point the Vertex provider at another host.
- **Who can get a token.** Forks get no OIDC token on a public repository, and Dependabot's runs are skipped. The subject `repo:<owner>/<repo>:pull_request` is well under 127 bytes. The bindings are per repository, through `attribute.repository`.
- **The guard.**
  - The listing is paginated. Artifact names can't hold a newline, so they can't break the parsing.
  - A forged or malformed `ocra-cost-*` name can only add to the sum.
  - A failed listing fails the job before anything is spent.
  - Expired artifacts are still listed and still count.
  - Attempts are separate entries.
  - A cancellation records the partial report ocra writes on SIGINT.
  - A report committed in the pull request predates the start mark and is ignored.
- **The setup script.** Every flag was checked against gcloud 586's help, including:
  - `budgets create` with a custom period (`--start-date`/`--end-date`), `exclude-all-credits`, repeated `--threshold-rule percent=…` and `--filter-projects projects/{id}`;
  - `iam roles create`/`update`.

  The script is idempotent and turns on only ocra's switch.
- **Workflow hygiene.**
  - The pins match their tags: checkout v7.0.1, upload-artifact v7.0.1, auth v3.0.0, and the Action v0.1.1.
  - There is no `pull_request_target`, and nothing is interpolated into `run:`.
  - actionlint 1.7.12 with shellcheck 0.11.0 is clean on both workflows and on the other repositories' caller.

## Not verified

- **The live token exchange with the pinned condition, and whether `aiplatform.endpoints.predict` alone is enough in practice.** The first end-to-end review (≤ $2) shows both.
- **Whether GitHub accepts the other repositories' callers at `@main`.** Calling a public repository's reusable workflow at a branch works as documented, but only the first run shows it.
