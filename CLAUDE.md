@AGENTS.md

## Keeping agent runs lean

- **Size the review to the risk.** Multi-agent workflows and max effort are for large or risky changes (data, auth, deployment, security). A small fix or doc change gets one agent at medium effort and a single review pass.
- **Keep tool output small.** Run tests with a quiet reporter (failures and a summary only), send full logs to a file in the scratchpad and `grep` or `tail` it. Never print whole build logs, lockfiles or generated files; read large files by line range or search them first. A single command should rarely print more than about 200 lines.
- **Hand off instead of growing one context.** Past about 300k tokens of context, or before stopping for more than an hour, write a short handoff (`../ocra-internal/handoff.md` or the issue) and continue in a fresh or compacted session.

## Agent skills

### Issue tracker

GitHub Issues for this repository, through the `gh` CLI; pull requests are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles, label string equal to role name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the root and `docs/adr/`. See `docs/agents/domain.md`.
