# Architecture Decision Records

| ADR | Decision |
|---|---|
| [0001](0001-typescript-monorepo.md) | TypeScript monorepo |
| [0002](0002-vcs-adapter.md) | VCS adapter abstraction, GitHub first |
| [0003](0003-opencode-runtime.md) | OpenCode as agent runtime behind `AgentRuntime` |
| [0004](0004-precision-first.md) | Precision by default, recall via `--ultra` |
| [0005](0005-review-tools-over-mcp.md) | Review tools delivered to the runtime over in-process MCP |
| [0006](0006-plugin-contract.md) | ocra plugin contract: bootstrap / configure / postConfigure |
| [0007](0007-review-matrix.md) | Review matrix: reviewer scopes, risk tiers and overrides decide the cells |
| [0008](0008-github-integration.md) | GitHub: code from git, conversation from the API, trusted inputs from the base revision |
| [0009](0009-fixed-needs-code-evidence.md) | A finding is fixed only when its code is gone; unreproduced findings stay open |
| [0010](0010-incremental-rereview.md) | Incremental re-review: the state records the reviewed head; only changed and unfinished files are reviewed again |
| [0011](0011-golden-eval-set.md) | Quality decisions on an ocra-owned golden set (expected findings, forbidden ranges, recorded adjudication); AACR-Bench stays the external number |
| [0012](0012-golden-labels-per-claim.md) | A golden label belongs to one claim about the code, not to every finding that quotes it |
| [0013](0013-fork-pull-requests.md) | Pull requests from forks run on `pull_request_target`; ocra runs nothing from a pull request |
| [0014](0014-adversarial-golden-cases.md) | Adversarial golden cases: hostile text planted in a golden case, measured against the case itself |
| [0015](0015-spend-limit-order-and-reporting.md) | Under a spend limit, tasks finish files in plan order so a pull request progresses across pushes; never-started tasks leave files unreviewed, and the report names the limit |
| [0016](0016-shared-review-conversation.md) | One review conversation for every platform in `vcs-platform` (trust rules, state, summary); GitLab second; line-leading slashes neutralized |
| [0017](0017-openai-compatible-providers.md) | Model providers declared in configuration: OpenAI-compatible endpoints, https, the key by variable name, a price for every model |
| [0018](0018-finding-specification.md) | The finding is the specification: one shared model with provenance (task, model, the task's cost), quote-anchored, three-valued verification; the JSON report is its published form, with a generated and tested JSON Schema |
| [0019](0019-sarif-import.md) | External findings enter as SARIF logs the CI job hands over; ocra runs no analyzer; only results on the change, as a synthetic task, verified and judged like a reviewer's |
| [0020](0020-direct-runtime.md) | A second runtime, `direct`: a tool loop over declared OpenAI-compatible endpoints, nothing else on the network; the runtime logic both share lives in core; a conformance suite every runtime passes |
| [0021](0021-reviewer-entity.md) | Proposed: the reviewer declares its tools; finding processors at two insertion points (after Execute, after Verify) that can keep, drop or downgrade with a recorded reason, never raise or add; `tools` can land now, processors with their first customer |
| [0022](0022-organization-policy.md) | Proposed: an organization policy named by `OCRA_POLICY` (pinned https or a runner file), never by the repository; it caps spend, allowed models, providers, runtimes, mandatory reviewers and excluded paths over every other layer, fails closed, and the report says what it did |
| [0023](0023-optional-opencode-runtime.md) | The OpenCode runtime is an optional dependency of the CLI, imported only when the configured runtime needs it; the Action's `opencode: false` installs without it (11 MB instead of 175 MB); no install cache |
| [0024](0024-ocra-cloud.md) | ocra Cloud: open core plus an optional hosted service on the published packages; Phase 1 is login (device flow), the user's own key kept in the cloud behind an allowlisted gateway that logs no bodies, metadata-only upload with content opt-in, and a web view; the hosted GitHub App is Phase 2, ocra-provided models Phase 3 |
| [0025](0025-per-agent-models-and-effort.md) | Models and reasoning effort per agent (reviewers, verifier, judge, helpers), in `.ocra/config.json` or as ocra Cloud account defaults layered under the repository's settings; runtimes map one level vocabulary to each provider and drop what a provider cannot express |
| [0026](0026-hosted-review-compute.md) | Proposed, deferred: hosted reviews for the ocra Cloud GitHub App in Cloudflare Containers (Cloud Run Jobs as fallback); GitHub Actions in an ocra-owned repository is ruled out by GitHub's terms (Sandbox SDK), one microVM per review, credentials injected outside the sandbox, egress limited to GitHub and the gateway; Cloud Run Jobs as the fallback |
| [0027](0027-account-configuration.md) | The review configuration's data settings (limits, verification, selection, rules, models) in the ocra Cloud account, under the repository's, versioned; never providers or extends; account-listed plugins load only from a per-machine install with its settings |
| [0028](0028-findings-upload-and-cloud-memory.md) | Per-reviewer counts in the default upload; findings uploaded only when the account turns it on (off by default, bounded, 90 days); the web shows full reviews and keeps memory in the account, applied under the repository's `.ocra/memory.json` |
| [0029](0029-committable-suggestions.md) | A finding may carry a `fix` (whole new-file lines and their replacement), rendered as a GitHub or GitLab committable suggestion only on an inline comment anchored to exactly those lines, posted exactly or not at all, and carried in the JSON report and SARIF; no stage sets it until an evaluated prompt change, since today's suggestion text cannot be turned into one safely |
| [0030](0030-task-ending-and-incomplete-coverage.md) | Revises ADR-0015 #2: every attempt has an ending (`done`, `step_cap`, `stopped_early`, `error`), read in core; a task that ends without the done tool leaves its files `incomplete` (partly reviewed), so the run exits 3 and the next review includes them |
| [0031](0031-reuse-completed-tasks.md) | A completed task records its reported findings under a key hashing its inputs; `ReviewOptions.resume` / `ocra review --resume` reuse matching tasks of an earlier run (and its bundles) instead of paying for them again; `ocra-eval --retry-failed` resumes. Amended 2026-10-09: only lines sealed with the user's own key are resumed; the key includes the commits |

Copy [0000-template.md](0000-template.md) to add a new record.
