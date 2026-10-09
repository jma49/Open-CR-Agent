# ADR-0027: The whole review configuration in ocra Cloud, except what can move code or keys

- Status: accepted
- Date: 2026-10-04

## Context

ADR-0025 put the runtime and each agent's model and effort in an ocra Cloud account, layered under the repository's configuration. The maintainer asked (2026-10-04) for every feature, plugins included, to be configurable in ocra Cloud, with a polished interface.

`.ocra/config.json` holds three kinds of settings. Most are data that shape a review: limits, verification, file selection, GitHub behavior, path rules, models. Some move code or keys: `providers` declares endpoints that receive the code, with a key read from the machine's environment by `apiKeyEnv`; `extends` fetches another configuration from any URL. And `plugins` load code that runs on the machine. Today all three are trusted because the repository's owner wrote them. A setting that comes from ocra Cloud is trusted only as far as the service is: if the service were compromised, a setting that names an endpoint and a variable could send a user's local provider key and code to an attacker, and a setting that names a plugin could run code on every signed-in machine.

## Decision

**1. Data settings live in the account, under the repository's.** Layering, highest first: command-line flags, the repository's configuration, the account's settings, built-in defaults; an organization policy (ADR-0022) caps all of them. The account may set:

- `models`, `effort`, `runtime`, `reviewers.<id>` (`enabled`, `minTier`, `models`, `effort`), `roles.<role>` (as ADR-0025);
- `concurrency`, `taskTimeoutMinutes`, `runTimeoutMinutes`, `maxCostUsd`, `maxTasks`, `verify`, `judge`, `sampling`;
- `include`, `exclude`;
- **rules**, path-scoped like `.ocra/rules.json`'s, at most 50 of 2,000 characters, embedded like the repository's (neutralized and bounded) and listed in the report with their source.

`include`, `exclude` and rules combine across layers, as `extends` and the policy already do; a repository's reviewer entry, tier or scalar wins whole. Layering under means the account can bound a run the repository left unbounded and never loosen one it bounded: a repository's `maxCostUsd` wins, and the user's own ceiling is the gateway's daily cap, which the web shows beside these limits. The CLI prints what the account filled in. Known keys are validated with the configuration's own schema; keys a CLI does not know are ignored with one warning naming them, so a newer web never breaks an older CLI.

Account settings apply in `--pr` and `--mr` runs as a layer under the base commit's file: they do not come from the reviewed tree, so ADR-0013 is untouched. In CI there is no session; Phase 2's hosted App will run with the installing account's settings and never load account plugins. `github.requestChanges` matters only in CI, so it waits for the App and per-repository profiles.

**2. Nothing from the account can move code or keys.** The account cannot set `providers` or `extends`. Models in account settings must be `ocra-<provider>/<model>`, which go through the gateway with the account's stored keys; a provider the account names is resolved only from the server's fixed list. `github.botLogin` stays in the repository's configuration: it decides whose comments are trusted. The CLI token gains read-only access to the settings (ADR-0024 scoped it to the gateway and the upload).

**3. Plugins from the account load only what the machine installed.** The account lists package names only. `ocra plugins allow <name>@<version>` shows the resolved package and its publisher, installs that exact version with install scripts off into `~/.config/ocra/plugins/`, and records name, version and integrity in `plugins.json`; `ocra plugins deny <name>` removes it. The CLI loads an account-listed plugin only from there (never from the reviewed checkout's `node_modules`, whatever the account names), and only where a repository's plugins could load (never in pull request mode from the reviewed tree, never with `--no-repo-config`). A listed plugin that is not allowed is skipped with one warning saying how to allow it. Allowing is the user's own supply-chain decision, like adding a dependency. `pluginSettings` from the account apply only to plugins the account itself lists and the machine allows; a repository plugin's settings come from the repository alone.

**4. What the user can see.** The web offers "your defaults as a `.ocra/config.json`" to copy (it cannot see a repository's file, so it does not claim to show the effective result), and imports a pasted file's data keys: `providers`, `extends`, `plugins`, `$schema` and `github.botLogin` are dropped and named; a model not of the form `ocra-<provider>/<model>` is rewritten when the account holds that provider's key, else dropped and named. `ocra review --plan` fetches the account settings and prints the effective merge with each key's source (file, account, default).

**5. Every save is a version.** Saves are listed with their time and the keys they changed, in the audit log beside key use (ADR-0024), and any version can be restored. The fetch returns the version id, which the report records in its provenance and the configuration hash covers.

## Consequences

- A user can run ocra with no file at all and still get their limits, rules, models and reviewers; a team's committed file still means the same on every machine.
- A compromised ocra Cloud can change review settings and rules (a cost or quality attack, bounded by `maxCostUsd`, the gateway's daily cap and the user's provider limits), and can make reviews of signed-in users go through the gateway, which it already proxies; it cannot point code at a new endpoint, read a local key, or run code.
- Per-repository profiles are left out: the server never learns repository names (the upload's hash is salted locally). If wanted, a later record can let the CLI bind a local repository to a named profile.

- Order: (1) limits, verification, `include`/`exclude`, `sampling` and rules, with versions, restore, export, import and `--plan` sources; (2) account plugins with the allowlist command and `pluginSettings`; (3) `github.requestChanges` and per-repository profiles with the App.

## Alternatives considered

- **Everything, plugins and providers included.** Rejected for the reasons above: it turns the service into a remote code execution and key-exfiltration channel.
- **Plugins only by built-in toggles.** Safe but short of the ask; the machine allowlist keeps third-party plugins possible with the user's consent on each machine.

Reviewed with Claude Fable 5.1: accepted with pluginSettings bound to account-listed plugins, a machine-owned plugin install path, combined include/exclude/rules, lenient unknown keys, settings versions in the audit log, and `--plan` showing the effective merge.

## Implementation notes (2026-10-09)

The trust boundary stands; the layering shipped with two additions and the policy it cites does not exist yet:

- **The full layer order**, highest first: command-line flags; the configuration, which is the repository's file or `--config`, what it `extends`, and the `OCRA_MODEL_*` and `OCRA_EFFORT_*` variables; account settings; built-in defaults. `ocra review --plan` names each setting's source.
- **The account may also turn on `ultra`**, the default for `--ultra` when the command line leaves it out. It is not a configuration key, so a repository cannot turn it off: an account's `ultra` sits above the repository, the one account setting that can raise a run's cost past what the repository chose. Where `maxCostUsd` is set it still bounds the run, the repository's value winning.
- **No organization policy caps any layer yet.** ADR-0022 is proposed, not implemented; read Decision 1's "an organization policy (ADR-0022) caps all of them" as "will cap all of them once ADR-0022 lands".
