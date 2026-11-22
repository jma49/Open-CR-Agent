# ADR-0056: Relaying a running review to ocra Cloud

- Status: accepted; amends [ADR-0024](0024-ocra-cloud.md) point 4 and [ADR-0028](0028-findings-upload-and-cloud-memory.md)
- Date: 2026-11-22

## Context

A review takes minutes. Until now ocra Cloud learned of one only from the upload after it ended, so nobody but the person at the terminal could follow it, and a teammate asked to look at a finding had to wait for the run and then for a link. Teams reviewing together want to watch a run as it goes, point at a finding while it is fresh and talk about it in one place, with the owner deciding who may look.

`ocra serve` already turns a run's events into the contract's `ReviewEvent`s (seq from 1 without gaps, findings replaced by id, one ending event), and the contract says ocra Cloud relays them. What was missing is the way there from a review that is not run by `ocra serve`, and the rules for who may see it.

The events carry file paths and finding text, which ADR-0028 sends only when the account shares findings.

## Decision

1. **The CLI relays, the server stores and fans out.** A signed-in review whose account shares findings (the same test as the upload's findings: the account's salt and this machine's consent) sends its events, mapped by `ReviewEventMapper`, to `POST /api/live` in batches (`liveBatchSchema`: the run's repository hash, source and pull request, and up to 100 events of one run, 512 KB). Hosted reviews (ADR-0046) run the CLI and so relay the same way; `ocra serve` and `ocra mcp` runs relay too.
2. **Best effort, never in the review's way.** One batch in flight, about once a second; a batch the server does not take stays queued and is sent again; three failures in a row stop the relay with one warning. A 404 (a server without the relay) or an answer without a `watch` address (the server stopped taking the run, past 5,000 events) stops it silently. At the end the CLI waits at most five seconds. `--no-upload` and `OCRA_CLOUD=off` relay nothing.
3. **Events are stored by (run, seq), first write wins.** A resent batch changes nothing; readers ask for events after the last seq they have. The server reads each event with `readReviewEvent`, so a newer CLI's new kinds are skipped rather than refused. It drops the batch when the account no longer shares findings, whatever the CLI sent.
4. **The owner shares a run, per person or by link.** A run is visible to its account. The owner can add a person by their sign-in name on that server, as a viewer or a commenter, and can turn on one link for the run, which lets anyone signed in to the server who has it watch (or comment, as the owner chose) until it is turned off or replaced. Nobody but the owner can share further, and no one signed out sees anything. Teams, when they come, grant to a team the way a person is granted now.
5. **Comments belong to the run** and may point at one of its findings by id. Commenters write, the owner can remove any comment, an author their own. Comments are text, shown as text.
6. **Watching is polling behind Server-Sent Events.** The page reads `GET /api/live/<run>/events` as an event stream that sends what is new, polls storage about once a second for up to 25 seconds, then ends; the browser reconnects with `Last-Event-ID`. The same code runs on Workers with D1 and on Node with Postgres; nothing needs a long-lived connection or shared memory between requests.

## Consequences

- Anyone with the owner's grant sees file paths and finding text for that run; the share drawer says so, and the default is shared with nobody.
- An account that does not share findings has no live view; its reviews appear after the upload, as before.
- A run's events cost a row each in ocra Cloud's database (at most 5,000), kept with the review data's retention.
- A later push channel (Durable Objects, Postgres `LISTEN`) can replace the polling without changing the client or the contract.
