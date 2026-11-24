/** How much of a failed job's log a round of `ocra mend --checks` reads. */
export const CHECK_LOG_LIMITS = { lines: 200, chars: 20_000 } as const;

// GitHub Actions and GitLab start a line with when it was written.
const TIMESTAMP = /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})? ?/;
// Colour and cursor sequences, then every other control character but a tab.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

// GitHub Actions opens a step with this line and names what failed with the next.
const STEP = /^##\[group\]Run /;
const FAILED = /^##\[error\]/;
// GitLab marks where the job's own script starts and ends, on the line of what follows.
const SECTION_MARK = /(section_(?:start|end):\d+:[\w.-]+(?:\[[^\]]*\])?)\r/g;
const SCRIPT_START = /section_start:\d+:step_script/;
const SCRIPT_END = /section_end:\d+:step_script/;

// The lines of the step that failed, where the runner marks its steps: what
// ran after it (clean-up, steps that always run, a job's after-script) would
// otherwise fill a log's end and push the failure out of it. On GitHub
// Actions, from the failed step's first line to the last line that names an
// error; on GitLab, the job's script section; else every line.
function failedStep(lines: string[]): string[] {
  const failed = lines.findLastIndex((line) => FAILED.test(line));
  if (failed >= 0) {
    const step = lines.findLastIndex((line, at) => at < failed && STEP.test(line));
    return lines.slice(Math.max(step, 0), failed + 1);
  }
  const start = lines.findLastIndex((line) => SCRIPT_START.test(line));
  if (start < 0) return lines;
  const end = lines.findIndex((line, at) => at > start && SCRIPT_END.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

/**
 * The end of a job's log as the fixer reads it: the last non-empty lines of
 * the step that failed, where the runner marks its steps,
 * without the runner's timestamps, terminal sequences and control
 * characters, cut to `CHECK_LOG_LIMITS`. ocra Cloud shows a failed job's log
 * through it, so a person reads what the fixer was given. The engine's own
 * copy is `logTail` in `@open-cr-agent/core`, which cannot depend on this
 * package; a test keeps the two equal.
 */
export function checkLogTail(log: string): string {
  const lines = log
    .replace(SECTION_MARK, "$1\n")
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI, "").replace(CONTROL, "").replace(TIMESTAMP, "").trimEnd())
    .filter((line) => line !== "");
  const tail = failedStep(lines).slice(-CHECK_LOG_LIMITS.lines).join("\n");
  return tail.length > CHECK_LOG_LIMITS.chars ? tail.slice(-CHECK_LOG_LIMITS.chars) : tail;
}
