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

Copy [0000-template.md](0000-template.md) to add a new record.
