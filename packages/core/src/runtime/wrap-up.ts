import { errorMessage } from "../errors.js";
import type { AttemptEnding, AttemptOutcome, TaskAttempt } from "./attempt.js";

type WrapUp = NonNullable<TaskAttempt["wrapUp"]>;

// The wrap-up turn of an attempt that ended without an error and without the
// done tool (at the step cap, or stopped early after the resume), unless the
// run no longer wants it: cancelled, timed out or past its spend limit, which
// all abort the signal.
export function pendingWrapUp(
  attempt: TaskAttempt,
  ended: AttemptEnding,
  signal: AbortSignal,
): WrapUp | undefined {
  if (!attempt.wrapUp || signal.aborted) return undefined;
  return ended === "step_cap" || ended === "stopped_early" ? attempt.wrapUp : undefined;
}

// The attempt's outcome after the turn. The attempt had finished, so a turn
// that fails keeps what it reported and spent but neither fails the task nor
// moves it to the next model; the error is recorded in the outcome.
export async function wrapUp(before: AttemptOutcome, turn: WrapUp): Promise<AttemptOutcome> {
  try {
    const { error, ...after } = outcomeOf(await turn());
    const findings = Math.max(0, after.findings.length - before.findings.length);
    return { ...after, wrappedUp: { findings, ...(error ? { error: error.message } : {}) } };
  } catch (error) {
    return { ...before, wrappedUp: { findings: 0, error: errorMessage(error) } };
  }
}

export function outcomeOf(attempt: TaskAttempt): AttemptOutcome {
  const { wrapUp: _turn, ...outcome } = attempt;
  return outcome;
}
