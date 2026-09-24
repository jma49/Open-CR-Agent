export const GENERAL_RULES = `### General correctness
- Logic that produces a wrong result on a reachable input: inverted or incomplete conditions, off-by-one bounds, wrong operator, wrong variable, unreachable or dead branches that were meant to run.
- Broken contracts between changed code and its callers or callees: changed signatures, return shapes, units, nullability or error behavior whose other side was not updated.
- Error handling that hides failure: swallowed exceptions, errors converted to success or default values, partial writes reported as complete, cleanup that masks the original error.
- State and resource bugs: missing cleanup on error paths, double release, leaked handles, mutation of shared or input data that callers do not expect.
- Concurrency hazards that the code makes reachable: unsynchronized shared state, check-then-act races, missing cancellation or timeouts on blocking work.
- Data integrity: lost updates, non-idempotent retries, inconsistent writes across stores, incorrect migrations or backfills.
- Security defects visible in the change: injection, missing authorization on a new path, secrets in code or logs, unsafe deserialization.`;
