# ADR-0022: Organization policy, a configuration the reviewed repository cannot override

- Status: proposed
- Date: 2026-10-02

## Context

M12 item 1 of the roadmap: "a central configuration the reviewed repository cannot override (allowed models, spend limits, mandatory reviewers, excluded paths), with a documented precedence over remote and repository configuration."

Today's layers, from the repository outward: `.ocra/config.json` (or the file `--config` names), then a shared file it points to with `extends` (https, optionally pinned; the repository's values win; a load failure is a warning and the run goes on with the repository's settings). Both are chosen by whoever can change the repository, so a team can raise its own spend limit, name any model, switch off a reviewer or review a path the organization excludes. Environment variables (`OCRA_MODEL_*`) override the file but are also set per workflow.

What an organization wants is the opposite direction: limits the repository cannot loosen, set where only the organization writes (a GitHub organization variable, a GitLab group variable, a file on a runner image) and failing closed when they cannot be read.

Drafted with Claude Fable 5.1; the maintainer decides.

## Decision (proposed)

1. **The policy is named by the environment, never by the repository.** `OCRA_POLICY` holds an `https` URL with a required `#sha256=` pin, or an absolute path to a file on the runner. The reviewed tree, `--config` and `extends` cannot set or change it. A policy that cannot be loaded, fails its pin or is invalid stops the run with the configuration exit code: a control that silently falls back is not a control.
2. **A policy caps; it does not configure.** Its keys are limits over whatever the other layers produce:
   - `maxCostUsd`: the run's limit is the smaller of the policy's and the configured one; a run without a configured limit gets the policy's.
   - `models.allow`: `provider/model` patterns (glob on the model part); a chain naming anything else fails configuration, with the pattern that would have allowed it. `providers.allow`: base URLs (exact, or a host) that declared providers may use; others fail.
   - `runtimes.allow`: which registered runtimes may run.
   - `reviewers.required`: reviewers that run on every change at their declared scope; a repository override cannot disable them or raise their minimum tier.
   - `exclude`: globs always excluded, combined with the repository's.
   - `plugins`: `"none"` forbids repository plugins (as `--no-repo-config` does), the default leaves the repository's choice.
   Keys the policy does not set change nothing. Precedence, highest first: policy caps, then command-line flags, then environment variables, then the repository's configuration, then `extends`.
3. **The report says what the policy did**: `policy: { source, applied: [...] }` in the JSON report (an optional addition to version 1) and one line in the summary comment when a cap bit (a lowered spend limit, a refused model, an excluded path), so a team sees why a run did less than its own configuration asked.
4. **The policy file is a contract** with a `version`, validated strictly; unknown keys fail, so a typo cannot silently un-cap. Its schema is published next to the report's.

## Consequences

- An organization can run ocra on many repositories with one spend ceiling, one model allowlist and one set of mandatory reviewers, and the repositories cannot undo it, which is what M13's external teams will ask first.
- Failing closed means a misconfigured `OCRA_POLICY` stops every review until fixed; the message names the variable and the reason. That is the intended trade.
- The policy adds a fourth configuration layer; the configuration page gets one precedence table for all of them instead of today's prose.
- Nothing here needs a model run; the first implementation is the loader, the caps on `maxCostUsd`, `models.allow` and `exclude`, and the report field, with the rest following as teams ask.
