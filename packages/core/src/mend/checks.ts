import { shortHash } from "../hash.js";

// What a round reads of a change request's failed checks (ADR-0078 point 3).
// A log is a test's output: anything may be in it, so it is cut here and
// reaches a prompt only as data.
export const CHECK_LIMITS = {
  checks: 3,
  logLines: 200,
  logChars: 20_000,
} as const;

const SIGNATURE_CHARS = 200;
const FAILURE = /\b(error|errors|failed|failure|fail|exception|panic|traceback)\b|✗|✘|×/i;
// GitHub Actions and GitLab start a line with when it was written.
const TIMESTAMP = /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})? ?/;
// Colour and cursor sequences, then every other control character but a tab.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

// The end of a job's log as a round reads it: its last lines, without the
// runner's timestamps and terminal sequences, cut to the characters a prompt
// takes.
export function logTail(log: string): string {
  const lines = log
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI, "").replace(CONTROL, "").replace(TIMESTAMP, "").trimEnd())
    .filter((line) => line !== "");
  const tail = lines.slice(-CHECK_LIMITS.logLines).join("\n");
  return tail.length > CHECK_LIMITS.logChars ? tail.slice(-CHECK_LIMITS.logChars) : tail;
}

// What tells one failure of a check from another: its first line that names
// a failure, else its last line, with the parts that change from run to run
// (numbers, ids, durations) taken out.
export function checkSignature(log: string): string {
  const lines = log.split("\n").filter((line) => line.trim() !== "");
  const line = lines.find((l) => FAILURE.test(l)) ?? lines.at(-1) ?? "";
  return line
    .replace(/\b[0-9a-f]{7,64}\b/gi, "#")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SIGNATURE_CHARS);
}

// A failed check as the loop's work item: it is the same item, with the
// same attempts, while its name and its failure's signature are unchanged
// (ADR-0078 point 8).
export function checkItemId(check: { name: string; log: string }): string {
  return shortHash(`check\0${check.name}\0${checkSignature(check.log)}`);
}
