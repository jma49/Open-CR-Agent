import { randomBytes } from "node:crypto";

// One id for a run, everywhere it leaves a trace: the session directory, the
// report, the progress output, the summary comment and the SARIF log. The
// time first, so directories list in order; six hex digits against two runs
// in the same second.
export function newRunId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}
