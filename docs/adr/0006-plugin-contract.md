# ADR-0006: ocra plugin contract

- Status: accepted
- Date: 2026-09-24

## Context

The architecture's first principle for extension is "everything is a plugin" (Cloudflare's `ReviewPlugin`). Until now the CLI wired the VCS adapter and runtime by hand, so adding GitHub, another runtime, a reviewer or team rules meant changing the CLI.

## Decision

An `OcraPlugin` has a `name`, an optional Zod `settingsSchema`, and three optional hooks:

| Hook | Runs | On failure |
|---|---|---|
| `bootstrap(ctx)` | all plugins concurrently | warning; the run continues (e.g. remote config unavailable) |
| `configure(ctx)` | in load order | fatal, naming the plugin |
| `postConfigure(ctx)` | concurrently, after the registry is frozen | fatal |

Plugins contribute only through `ConfigureContext`: `registerVcs`, `registerRuntime`, `registerReviewer`, `registerRules`, `registerTool`, `onEvent`. Each receives only its own validated settings section. The registry rejects duplicate plugin names, duplicate registrations (naming both owners), reserved tool names (`read_file`, `report_finding`, …) and any registration after the configure phase.

Built-in plugins: `vcs-local`, `vcs-github`, `runtime-opencode`, `reviewer-correctness`, `session-jsonl`. The CLI is a host: it finds the repository root, loads `.ocra/config.json`, loads extra plugins listed in `plugins`, starts the lifecycle, then creates the VCS and runtime by name and runs the pipeline with the registered reviewers, rules and event listeners.

External plugins are npm packages resolved from the repository's own dependencies, or paths inside the repository, exporting an `OcraPlugin` as `default` or `plugin`. Their settings come from `pluginSettings.<name>`.

## Consequences

- New platforms, runtimes, reviewers, rule packs and telemetry ship without CLI changes.
- Tools registered by plugins are served to agents over MCP (ADR-0005).
- Loading plugins executes code named in repository configuration. That is acceptable for local runs on one's own repository; CI integration (M3) must read configuration from the trusted base branch, not from the pull request.
