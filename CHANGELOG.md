# Changelog

Changes to the `@open-cr-agent/*` packages and the GitHub Action. The packages are released together at one version. While that version is 0.x, a minor release may change options, configuration and output; each such change is listed here.

## Unreleased

- A run warns when model calls used tokens but reported no cost, because their model has no price and the spend limit cannot count them.
- **Your own model endpoint.** `.ocra/config.json` may declare providers that speak the OpenAI API (`providers`, `"type": "openai-compatible"`): a self-hosted vLLM or Ollama server, or a company gateway. The endpoint must be `https`, or `http` on this machine. The key is named by its environment variable, never written in the file, and only that variable reaches the runtime. Every model has a price per million tokens, so cost and the spend limit count it (ADR-0017). The new Model providers page lists what each provider needs and which ones were tested live. The security page now says that OpenCode fetches its model catalog and tries to install its plugin package from npm when it starts, neither of which a review needs.
- **A container image.** Each release is also `ghcr.io/jma49/ocra:<version>` (and `latest`), for amd64 and arm64: the published packages installed as the GitHub Action installs them, git, the unprivileged `node` user, and build provenance. For GitLab CI, Jenkins and other runners.
- **GitLab merge requests.** `ocra review --mr <iid> [--project <id|path>] [--publish]` reviews a GitLab merge request, on GitLab.com or self-managed GitLab, and posts a thread on each finding in the diff and one summary note, updated in place. Later pipelines review only what changed. The rules are GitHub's: overrides and dismissals from people with the Developer role or higher other than the author, in comments nobody else edited. It needs `GITLAB_TOKEN`, a project access token with the `api` scope; in GitLab CI, `CI_API_V4_URL` and `CI_PROJECT_ID` are read. The manual has a GitLab CI job. New package `@open-cr-agent/vcs-gitlab` (ADR-0016).
- `GITLAB_*` and `CI_*` variables never reach the model runtime by name prefix, like `GITHUB_*`: GitLab CI puts `CI_JOB_TOKEN` in every job.
- **A line of model text that starts with a slash is posted with a zero-width space before it**, in the summary and in inline comments. GitLab runs a comment line such as `/merge` or `/approve` as a quick action with the rights of the token that posted it. ocra neutralized only its own `/ocra` commands.
- **ocra recognizes its own inline comments.** A finding whose thread ocra started, with a marker comment nobody else edited, is not commented again, even when the summary's state is missing or cannot be trusted. Before, a summary edited by someone else made ocra post its earlier inline comments again.
- **New package `@open-cr-agent/vcs-platform`**: the review conversation every platform shares (who may override or dismiss, which state counts, the summary and inline comment text), which `vcs-github` now uses (ADR-0016). `@open-cr-agent/vcs-github` no longer exports the summary rendering and the review state; import them from `@open-cr-agent/vcs-platform`.
- **SARIF output.** `ocra review --format sarif` writes the review as a SARIF 2.1.0 log for code scanning and security dashboards: one rule per reviewer category, one result per finding, with its fingerprint, lines, verification and status. The manual shows how to upload it to GitHub code scanning from the Action.
- **What a spend limit leaves is named.** Files whose review tasks the limit never started are reported as not reviewed (`unreviewed`), no longer as failed. The run warns how many tasks did not start. The pull request summary and the terminal say the spend limit was reached, and the JSON report has a new optional `spendLimit` field (`{ usd, reached }`). A pull request's next review already continued with those files; the summary now says so. When the review state is too large for the summary comment, and the next review has to start over, the review warns.
- The GitHub Action installs ocra's packages from npm only when their provenance shows they were built by this repository's release workflow from the version's tag. Otherwise, for example for a version published from a stolen npm login, it builds its own source and warns. `npm audit signatures` alone passed packages that have no provenance.
- With `npm install --omit=optional`, ocra now finds the OpenCode binary that `opencode-ai`'s install script downloads, where npm runs that script. It used to stop and ask for `OCRA_OPENCODE_BIN`.
- A security policy (`SECURITY.md`, with private reporting through GitHub), a contributing guide, a code of conduct and issue templates. The manual's new Stability and support page lists what counts as a contract and how it may change between releases.
- A run no longer says it reviewed nothing when one reviewer finished its tasks and another failed on the same files (#263). Such a run is still incomplete (exit code `3`), but its verdict, summary and findings now stand.

## 0.1.2

A run's spend limit now holds, text a model wrote can no longer count as a command or post a link, and OpenCode no longer runs inside the checkout it reviews.

### Packages

- **`--max-cost-usd` stops running review tasks.** It used to stop only new ones from starting, so tasks already running went on: one review with a $2 limit spent $4.70.
  - Running tasks now report their spend about every 10 seconds.
  - When the review share (80% of the limit) runs out, every running review task stops. It keeps what it found, its files count as not reviewed, and the run exits `3`.
  - A run can still pass the limit by what each running task spends between two reports, plus its step in progress.
- **Web addresses in text a model wrote stay text.** A pull request could plant an address, in a code comment for example, and get a reviewer to repeat it; the adversarial probe saw exactly that. Posted, it became a link in a comment from ocra. Addresses in findings and summaries now read the same but are no longer turned into links. ocra's own links are unchanged.
- **OpenCode runs in an empty directory of its own**, not in the checkout under review. Before, only a setting that turns off OpenCode's project configuration kept plugins and custom tools committed in the reviewed code (`.opencode/`, `opencode.json`) from loading next to the model credentials. A test now plants them and checks each of the two protections on its own.
- **Commands never come from ocra's own comments.** `/ocra override` in text a model wrote, or anywhere in ocra's summary comment, no longer counts, even when ocra posts with a person's token and `github.botLogin` is left at its default. In that configuration, a judge summary that repeated an override planted in the pull request could let a blocked pull request pass.

### GitHub Action

- Use `jma49/Open-CR-Agent@v0.1.2`.
- The manual now has a threat model, and a way to review pull requests from forks on `pull_request_target` with a maintainer's label as the gate.

## 0.1.1

The GitHub Action now runs the published CLI instead of building the repository on every run. This is also the first release published from GitHub Actions with npm provenance. The CLI and the libraries have not changed since 0.1.0.

### GitHub Action

- Use `jma49/Open-CR-Agent@v0.1.1`.
- It installs `@open-cr-agent/cli` at the Action's own version from npm, into a directory of its own.
  - Every dependency is at the version the release was tested with: the tag's `package-lock.json`, with integrity hashes.
  - Install scripts are off.
  - On the npm registry, `npm audit signatures` checks the registry's signature on every installed package, and its provenance where it has one. A failed check stops the job. With a mirror configured, only the lockfile's integrity hashes are checked.
  - It uses an npm cache of its own, not `~/.npm`, and turns off `setup-node`'s automatic npm cache, which would have saved a cache entry in your repository.
- Setup takes about as long as before: 8–9 s on GitHub-hosted runners, either way. What changes is what runs:
  - the published packages, with provenance from this release on;
  - no build tools with your model key in the environment, unless it builds from source (below).
- It still builds the Action's ref from source when:
  - that version is not on npm yet (a release's first minutes);
  - npm has that version with other dependencies than the ref declares;
  - the pinned install fails.
- `@main` now runs the latest release named on `main` rather than unreleased code, unless `main` has changed its dependencies since. Pin a release tag or its commit.

### Packages

- Published by `.github/workflows/release.yml` through npm trusted publishing. `npm audit signatures` verifies each package's provenance, and each package's page on npmjs.com shows the repository, workflow and commit it was built from.
- `npm install -g @open-cr-agent/cli` still resolves third-party dependencies when it runs. Pinning them with an `npm-shrinkwrap.json` would make npm install every OpenCode binary for every OS and CPU, 2.1 GB instead of 175 MB.

## 0.1.0

The first release of ocra (Open-CR-Agent), an open-source multi-agent code reviewer for local changes and GitHub pull requests. It is early: it has been measured on a small set of cases, with one family of models, and options may still change. Read [what reviews find and miss](https://ocra.majincheng.com/en/docs/quality) before you rely on it.

### Install

```bash
npm install -g @open-cr-agent/cli
ocra --version
```

Requires Node.js 22.19 or newer and Git. Reviews run on [OpenCode](https://opencode.ai), which is installed with ocra, and on the models you choose from any provider OpenCode supports, with your own API key. Start with the [quickstart](https://ocra.majincheng.com/en/docs/quickstart). The GitHub Action is `jma49/Open-CR-Agent@v0.1.0`.

### What it does

- Reviews uncommitted changes, a branch, a range, a single commit or a GitHub pull request. The [GitHub Action](https://ocra.majincheng.com/en/docs/github) posts inline comments and one summary, and on the next push reviews only what changed.
- Deterministic stages select and bundle the files, pick the reviewers by risk, match rules and anchor every finding to exact lines. The models make the judgment calls: correctness, security, performance, docs and `AGENTS.md` reviewers with read-only tools.
- A verification pass checks each finding against the code, and a judge merges duplicates and drops speculation. The verdict comes from a fixed rubric, and a critical finding the verifier did not confirm cannot block.
- `--ultra` trades cost for recall: every reviewer at every risk tier, two samples each, a plan phase, and the callers of changed symbols.
- It remembers decisions: `ocra memory` records findings a team accepts, and dismissals and replies in pull request threads count on later reviews.
- Everything is a plugin: VCS adapters, agent runtimes, reviewers, rules, tools and event listeners.
- Hardened for pull requests from outside contributors: agents cannot write files, run commands or browse; likely secret files cannot be read; configuration comes from the base branch; text from the change is fenced off in every prompt.

### Cost controls

- `ocra review --plan` shows the files, tasks and prompt sizes of a review without calling a model.
- `--max-cost-usd` (or `maxCostUsd` in `.ocra/config.json`) sets a spend limit for a run. Every run reports tokens and dollars.
- Steps per agent (30), tasks per run (60 by default) and run time are capped. Each model tier takes a failback chain: short rate limits are waited out, and a model out of quota is dropped for the rest of the run.

### Known limitations

- Recall is the weak point: reviewers miss issues a careful human reviewer would find. The [quality page](https://ocra.majincheng.com/en/docs/quality) has the numbers and how they were measured.
- Quality has been measured with Google Gemini models only.
- GitHub is the only pull request platform.
- The verdict is advice, not a security gate: the models read the change, and text in it can steer them.
- Do not install with `--omit=optional`: the OpenCode binary comes as an optional package, and without it `ocra review` stops and asks for `OCRA_OPENCODE_BIN`.
- The JSON report (`--format json`) and `--plan --format json` are versioned (`"version": 1`); later releases only add optional fields, or change the version.
