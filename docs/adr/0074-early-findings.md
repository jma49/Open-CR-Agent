# ADR-0074: Verify starts while tasks run, and confirmed critical findings are settled early

- Status: accepted; amends [ADR-0056](0056-live-review-relay.md)
- Date: 2026-11-23

## Context

A review's result arrives at its end: the tasks run, then memory and the previous review filter their findings, Verify checks them file by file, the judge merges, drops and recalibrates, and only then is anything posted or shown as a result. On a change of 27 files in ocra Cloud that is about four minutes; the first task ends within the first half minute.

A watcher of a live run ([ADR-0056](0056-live-review-relay.md)) does see findings sooner, as each task reports them, but those are raw: unchecked, with the copies two reviewers made of one problem, and with everything Verify will refute and the judge will drop. They appear and then disappear, so nothing shown before the end can be acted on.

Two facts make an early result possible. Verify works on one file at a time and needs nothing from the tasks still running. And the judge can neither drop nor downgrade a critical finding the verifier confirmed ([ADR-0032](0032-verification-gates-blocking.md)): its place in the report is decided the moment Verify answers.

Measured with `ocra-eval perf` (scripted model, 400 ms a request) on a change of 93 files and 54 tasks, the verifier's first answer came 16.6 s into a run of 18.7 s.

## Decision

1. **A file's findings go to the verifier as soon as every task that reviews the file has ended** (`pipeline/early-check.ts`), in the tasks' order, after the same per-finding filters the run applies later: one copy of a fingerprint, nothing memory accepts, nothing a person dismissed that did not come back more severe. The call is the one Verify would make: same prompt, same model, same spend limit.
2. **A finding is verified once.** Verify, after the tasks, checks only what the early calls did not answer: a finding that names a file after its tasks ended, an imported one, a copy that turned out more severe. Among equally severe copies of a fingerprint the run keeps the one already checked.
3. **A critical finding the verifier confirms is settled:** the report carries it as it is. The judge already cannot drop or downgrade it; it now also cannot merge it away (a duplicate is merged into it, and two settled findings named duplicates both stay). Of confirmed critical findings on overlapping lines of a file only the first is settled, so the judge still merges the others. A pre-existing finding is not settled when `showPreExisting` is off.
4. **Everything else waits for the judge.** A warning, a suggestion or an unconfirmed critical finding may still be dropped, merged or recalibrated, so it is not a result before the run ends.
5. **Events.** Core emits `findings_verified` for each file checked early (the kept findings with the verifier's answer, the ids refuted, the ids settled). On the wire (`@open-cr-agent/cloud-contract`) a finding is sent again when verified, with `settled: true` when it is, and with `dropped` when refuted; the findings sent at the end are all settled. The terminal prints one `Confirmed:` line for each settled finding.

## Consequences

- On the change above the verifier's first answer came at 5.8 s instead of 16.6 s, with the same 302 requests and the same input tokens, and the run ended about 5% sooner because Verify no longer waits for the last task. A change with one or two tasks gains nothing: its tasks end together.
- A reader of the wire can show settled findings as results while the run goes on and hold the rest back until it ends, which is what ocra Cloud's live page does. No settled finding is ever taken back, short of the run failing without a report.
- Verify's prompts are unchanged, and in the common case so are its calls. They differ when a task reports a finding on another bundle's file after that file was checked: the finding is verified in a call of its own instead of with the file's others. No prompt of a reviewer or the judge changes, so no evaluation was run.
- Two confirmed critical findings on different lines that the judge calls duplicates both stay in the report, where one was merged before.
- Verify's calls now overlap the tasks, so up to twice `concurrency` model calls can be in flight, and a run near its spend limit pays for a file's verification before the tasks that use the limit up, where before it would have left those findings unchecked.
- Nothing is posted to the pull request before the run ends. A comment notifies people and cannot be taken back; posting settled findings early is left until the live page shows it is wanted.

## Alternatives considered

- **Showing every verified finding early.** The judge drops and merges among them, so findings would still disappear from view.
- **Judging in rounds as files finish.** Duplicates are found across the whole run; a round cannot see what a later task reports, and each round is a top-tier call.
- **Verifying each task's findings as the task ends.** A file reviewed by several reviewers would be sent to the verifier once for each, with the same excerpt.
