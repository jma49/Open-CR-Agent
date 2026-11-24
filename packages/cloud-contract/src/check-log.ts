/** How much of a failed job's log a round of `ocra mend --checks` reads. */
export const CHECK_LOG_LIMITS = { lines: 200, chars: 20_000 } as const;

// GitHub Actions and GitLab start a line with when it was written.
const TIMESTAMP = /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})? ?/;
// Colour and cursor sequences, then every other control character but a tab.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * The end of a job's log as the fixer reads it: its last non-empty lines,
 * without the runner's timestamps, terminal sequences and control
 * characters, cut to `CHECK_LOG_LIMITS`. ocra Cloud shows a failed job's log
 * through it, so a person reads what the fixer was given. The engine's own
 * copy is `logTail` in `@open-cr-agent/core`, which cannot depend on this
 * package; a test keeps the two equal.
 */
export function checkLogTail(log: string): string {
  const lines = log
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI, "").replace(CONTROL, "").replace(TIMESTAMP, "").trimEnd())
    .filter((line) => line !== "");
  const tail = lines.slice(-CHECK_LOG_LIMITS.lines).join("\n");
  return tail.length > CHECK_LOG_LIMITS.chars ? tail.slice(-CHECK_LOG_LIMITS.chars) : tail;
}
