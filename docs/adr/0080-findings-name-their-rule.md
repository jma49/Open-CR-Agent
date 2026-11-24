# ADR-0080: A finding names the repository rule or learning it applies

- Status: accepted
- Date: 2026-11-24

## Context

ocra Cloud wants to show, per rule, how often its findings are accepted or declined, so a team can see which of its rules earn their place. A finding comes from a model, and nothing on it said which rule or learning led to it. Learnings have stable ids already (their file names, ADR-0044); repository rules had none: `.ocra/rules.json` entries are a path and a text, `.ocra/rules.md` sections a heading and a text, and account, shared and plugin rules the same.

Matching a finding to a rule after the fact (by text similarity, by path) would guess, and a guess attached to a rule's acceptance rate is worse than no number. Only the reviewer that applied a rule knows it did.

## Decision

1. **Every repository rule has an id.** `rules.json` takes an optional `id` (lowercase letters, digits and `-`, at most 64 characters). A `rules.md` section's id is its heading in lowercase with `-` between words; a heading without Latin letters or digits names none. A rule without an id is named `rule-` and 8 hex characters of the SHA-256 of its trimmed text, so the id holds while the rule reads the same. Ids are unique within a review: a repeat gets `-2`, `-3`, in the order the rules are layered. The report's provenance lists each rule with its id.

2. **The prompt shows rules under their ids.** The repository rules section gives each matching rule as `Rule <id>:` and its text; learnings already carry their id.

3. **The reviewer names the rule; code checks it.** `report_finding` takes an optional `rule`: the id of the repository rule or team learning the finding applies. The task keeps it only when the id is one the task was given: a rule matching its files, or a learning given or listed to it, and not left out by `--without`. Anything else (a made-up, misspelt or other task's id) is dropped and the finding kept; a finding is never refused for its rule, since refused arguments lost findings before (#742 to #744).

4. **The finding carries `rule: { kind, id }`.** `kind` is `rule` or `learning`, set by code from what the task was given. The report's findings have it, and the Cloud upload's shared finding has it under the contract's `FINDING_RULE_KINDS` and `FINDING_RULE_ID`, read as absent when malformed, like every optional field there.

## Consequences

- ocra Cloud can count accepted and declined findings per rule and per learning, and show a rule's text from the report's provenance.
- A finding without `rule` means the reviewer named none, not that no rule applies: the counts are a floor.
- Editing a rule without an `id` changes its id and starts its counts afresh; teams that care give it an `id`.
- The prompt grows by a line per matching rule and the tool by one optional field; a smoke comparison checks that recall and precision do not move.
