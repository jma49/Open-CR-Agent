---
"@open-cr-agent/core": minor
"@open-cr-agent/runtime-direct": minor
---

### Changed

- Generated migration metadata is no longer reviewed: Drizzle's `meta/` snapshots and journal, Prisma's `migration_lock.toml`, EF Core's `*.Designer.cs` and model snapshot; nor are the lock files of Deno, NuGet, SwiftPM, CocoaPods, pub, Mix and Gradle. `include` brings a file back.
- On an `anthropic` provider, review tasks read the start of the prompt they share from the prompt cache instead of each storing it (`AgentTaskSpec.sharedPrefixes`).
