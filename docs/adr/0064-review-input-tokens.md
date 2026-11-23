# ADR-0064: Generated migration metadata is not reviewed, and tasks share the start of their prompts

- Status: accepted
- Date: 2026-11-23

## Context

The first hosted reviews on Claude models (2026-11-23, direct runtime, Messages wire) sent about 2 million input tokens for a change of 27 files in 50 tasks. `ocra review --plan` and `ocra-eval perf` (ADR-0061) on the same two changes show where they went:

- **Two schema snapshots were most of it.** A migration made with Drizzle adds `meta/<n>_snapshot.json`, the whole schema after the migration: about 6,500 lines each, one per database. Selection kept them (`migrations/` is never treated as generated), four reviewers were each given each file whole, about 50,000 tokens a prompt, and every later step of those tasks sent it again. They and their two journals were 16 of 60 tasks and 418,000 of the 600,000 tokens of first prompts; a plan call and a verification read them again.
- **Of what is left, three quarters is not the diff.** 23 files in 44 tasks: 182,000 tokens of first prompts, of which the diffs are 47,000. The rest is what every task is given again: the reviewer's instructions (39,000), the guidelines (70,000), the list of changed files, the rules. The prompt order (ADR-0057) puts what tasks share first, but on the Messages wire a conversation's first message was one block, stored in the provider's cache only as a whole: a task read nothing another had stored, and paid the price of stored input, a quarter above fresh input, for a start it shared with every other task of its reviewer.

## Decision

1. **What a migration tool writes next to its migrations is generated** (`MIGRATION_METADATA_PATTERNS`): Drizzle's `meta/<n>_snapshot.json` and `meta/_journal.json`, Prisma's `migration_lock.toml`, and EF Core's `*.Designer.cs` and `*ModelSnapshot.cs` under `Migrations/`. The migration itself says the change and is still always reviewed. `include` in the configuration brings such a file back, as for any generated file. More lock files are generated too: Deno, NuGet, SwiftPM, CocoaPods, pub, Mix and Gradle.
2. **A review task says where the shared start of its prompt ends** (`AgentTaskSpec.sharedPrefixes`): after the change request, the changed files and the linked tasks, which every task of a run is given word for word, and after the guidelines, which are the same unless a guideline scope chooses them by bundle (ADR-0059). The prompt's text is unchanged.
3. **The Messages wire sends the first message in blocks that end there, each with a cache mark.** With the system prompt's mark and the newest block's that is four, the most the API takes. A later task of the same reviewer reads the start from the cache at a tenth of the input price instead of storing it again. The chat completions wire and the OpenCode runtime ignore the offsets: those providers cache a repeated start on their own, if at all.

## Consequences

- With the scripted reviewer of `ocra-eval perf`, the first change goes from 60 tasks, 300 requests and 4.72 million input tokens to 44 tasks, 216 requests and 1.70 million; the second from 303 requests and 4.74 million to 267 and 2.40 million. The scripted reviewer takes more steps than a model does, so the totals are not what a model is billed; the proportions are the engine's.
- For the tasks that remain, two thirds of each first prompt (122,000 of 182,000 tokens on the first change) are the shared start. All but each reviewer's first task read them from the cache: counted at the provider's prices, the first prompts cost a little under half of what they did. The number of tokens sent does not change.
- Nothing a reviewer could find a defect in is left out: a snapshot repeats the migration next to it, and a mistake in it is the tool's. A team that edits such files by hand lists them in `include`.
- The cache needs a prefix of 1,024 tokens or more on most models and more on the smallest; a mark on a shorter one does nothing. Tasks that start together each store the start; with the default concurrency that is each reviewer's first task.
- Not measured on a paid model: the marks are checked against the wire's test endpoint only. No evaluation was run, as none of the remaining prompts changes by a character.
- Still open: 44 tasks for 23 files repeat 3,000 tokens of instructions and guidelines each. `--guidelines reviewer` (ADR-0059) removes most of the guidelines' share and waits for its ablation.
