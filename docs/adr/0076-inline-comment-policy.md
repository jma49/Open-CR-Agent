# ADR-0076: An inline comment policy, and turning ultra off

- Status: accepted
- Date: 2026-11-23

## Context

On a pull or merge request every finding anchored to lines in the diff becomes an inline comment. A team that wants fewer comments could only switch reviewers off, which also loses what those reviewers find. ocra Cloud's hosted review profiles have the same limit: a "quiet" profile could only turn reviewers off.

`--ultra` had the opposite gap. The account's settings could turn it on, the command line could add it, and nothing could turn it off again, so an account with `ultra` on got it in every run, whatever the repository or a hosted profile wanted.

## Decision

1. **Two keys choose which findings are posted inline:** `minInlineSeverity` (a severity floor) and `maxInlineComments` (a cap, 0 to 1000), in `.ocra/config.json`, an extended configuration and the account's settings, with `--min-inline-severity` and `--max-inline-comments` over them. They live in the configuration schema in `@open-cr-agent/cloud-contract`, so ocra Cloud writes them into the configuration file it passes with `--config`, and the account's settings (`reviewSettingsSchema`) take them too.
2. **The policy holds findings back from inline comments, never from the report.** Every finding stays in `findings`, counts towards the verdict and the exit code as before, and the summary comment lists the held ones in a folded section with the reason. Dropping them, as `showPreExisting: false` does, would hide a real finding because of a preference about noise, and an incomplete report is worse than a long summary.
3. **The choice is made once, in core, from the report alone** (`report/inline.ts`): of the findings anchored to lines in the diff, those below the floor are held, then the rest are ranked and those past the cap are held. The rank is severity, then Verify's answer (confirmed, uncertain, unchecked), then findings not marked low confidence, then file, first line and fingerprint, so the same findings win whatever order the tasks ended in. The report carries the policy and the held fingerprints with their reason (`inline` in the JSON report), and the platform layer (`PlatformReview.publish`) skips them; GitHub and GitLab behave the same through it.
4. **The cap counts the review's findings, not what is on the platform.** A finding commented on in an earlier review and reported again takes a place without being posted twice. Counting the threads already open instead would make the choice depend on the platform's state, so the report could not record it, and an old suggestion could keep a new critical finding out.
5. **`ultra` is a configuration key, and `--no-ultra` its flag.** The layers apply as for other settings: the account's `ultra` only where the configuration does not set it, and `--ultra` or `--no-ultra` over both. A run's configuration hash records the ultra that ran, as before.

## Consequences

- A hosted "quiet" profile can map to `minInlineSeverity`, `maxInlineComments` and `ultra: false` in the configuration file ocra Cloud passes, once ocra Cloud pins a release with this change.
- With a cap, a change reviewed after several pushes can still collect more inline comments than the cap over time, since each review applies it to its own findings.
- No prompt, rule or review stage changes: what is found and reported is the same, only where the platform shows it, so no evaluation was run.
