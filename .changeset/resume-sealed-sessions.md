---
"@open-cr-agent/core": patch
"@open-cr-agent/cli": patch
---

### Security

- `ocra review --resume` reuses only what ocra on this machine wrote: each session line is sealed with a key of the user's kept in `~/.config/ocra/session-key`, and a session without valid seals (another machine, another user, or one that came with the change) is refused. The session log is read without following links, as a regular file, within 64 MiB; bundles come from the sealed log, not `report.json`.
- `sessionJsonlPlugin` takes an optional `sealKey` setting that seals each line it writes.
- Reading a JSON report (`ocra metrics`, `ocra memory`) refuses anything but a regular file and stops at 64 MiB.

### Fixed

- A resumed run no longer reuses a task made for other commits whose hunks read the same, and takes reused tasks before the spend limit, so a run that hit `--max-cost-usd` no longer skips them.
