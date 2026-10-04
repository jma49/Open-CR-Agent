import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReportOutput } from "@open-cr-agent/core";
import { REPORT_FILE, readReport } from "@open-cr-agent/core/internal";

// Where a repository keeps its review sessions: one directory per run, named
// by the run id, written by core's session log (sessionJsonlPlugin).
export const SESSIONS_DIR = ".ocra/sessions";

export function sessionsDir(root: string): string {
  return join(root, SESSIONS_DIR);
}

export function reportPath(sessionDir: string): string {
  return join(sessionDir, REPORT_FILE);
}

/** The session ids in a sessions directory, oldest first; none when it does not exist. */
export async function listSessions(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [])).filter((n) => !n.startsWith(".")).sort();
}

// A session directory is named by its run id, whose first part is the start
// time (newRunId in core).
export function sessionStart(id: string): Date | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(id);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
}

// A session's version 1 report; undefined when it is missing, unreadable or
// of another version, which `ocra metrics` counts as unreadable.
export async function readSessionReport(sessionDir: string): Promise<ReportOutput | undefined> {
  return readReport(reportPath(sessionDir)).catch(() => undefined);
}
