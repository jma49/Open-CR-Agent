# ADR-0013: Pull requests from forks run on `pull_request_target`; ocra runs nothing from a pull request

- Status: accepted
- Date: 2026-09-29

## Context

ADR-0008 runs the Action on `pull_request`. There, a pull request from a fork gets no repository secrets and a read-only token, so its review stops at the missing model key. Pull requests from people outside the repository are the case ocra is built for (roadmap M8), and until now the manual said never to use `pull_request_target`.

GitHub warns against `pull_request_target` because it gives a job the repository's secrets and a write token while the pull request is controlled by someone else. The attacks it enables come from running the pull request's code: a checkout of the head followed by an install, a build or a test. ocra already treats the pull request as data. It fetches the commits and reads them through git, reads configuration, rules, memory and guidelines from the base commit, never loads repository plugins, starts OpenCode without project configuration, and gives agents no shell, write or web tool.

## Decision

1. **Pull requests from forks are reviewed on `pull_request_target`**, with the base branch checked out and no step that checks out, installs, builds or tests the head. The manual's workflow (`github.mdx`, "Pull requests from forks") reviews members' and collaborators' pull requests on every push, and anyone else's once each time a maintainer adds a label. It caps each review with `--max-cost-usd`, pins the Action by commit, and asks for a model key used only for reviews, with a spending limit at the provider.
2. **ocra runs nothing from a pull request.** In pull request mode and under `--no-repo-config`, nothing from the reviewed tree runs: no plugin, OpenCode configuration or tool, install script, external diff driver or text conversion, and nothing a feature would build or test. A plain local review still trusts the checkout the user chose. A feature that needs to run repository code belongs in a separate job without secrets, not in ocra.
3. **The threat model is a manual page** (`threat-model.mdx`). It names who can attack and what they control, pairs each attack with its defense, and states what ocra does not protect against, so a maintainer can decide where to run ocra.

## Consequences

- Maintainers of public repositories can review outside contributions, the positioning M8 tests.
- A flaw in how ocra, OpenCode, git or Node.js handles untrusted input now runs with secrets and a write token for anyone whose pull request gets reviewed. The label gate keeps outsiders' pull requests from starting a review on their own. The defenses have tests. The residual risk is on the threat-model page, with the advice to use a key that can only spend a limited amount.
- Contributors must treat rule 2 as a contract: a change that could run repository content, for example a reviewer that runs a linter from the repository's configuration, breaks the guarantee users rely on (`AGENTS.md`, Security).
- Not yet checked live: a real fork pull request through this workflow. The dogfood identity trusts only `pull_request` events, so the check needs the maintainer (`docs/pending-verification.md`).
