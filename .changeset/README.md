# Changesets

Every pull request that changes what users of the `@open-cr-agent/*` packages or the GitHub Action see adds a changeset here: run `npx changeset`, pick any package it touches (they are released together at one version) and the bump, then write the body as entries for `CHANGELOG.md`, under its Keep a Changelog sections:

```markdown
---
"@open-cr-agent/cli": minor
---

### Added

- `ocra review --foo` does bar ([#123](https://github.com/jma49/Open-CR-Agent/pull/123)).
```

Sections: `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, `### Security`. One short line per entry; the details go in the pull request or the manual. A change users do not see needs no changeset, or `npx changeset --empty` when CI asks for one. [docs/releasing.md](../docs/releasing.md) has the rest.
