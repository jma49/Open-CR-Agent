import { at } from "../at.js";
import type { CoverageEntry } from "../report/report.js";
import type { FileDecision } from "../select/select.js";
import type { JobResult } from "./execute.js";
import type { MatrixCell } from "./matrix.js";

export function coverageOf(
  decisions: readonly FileDecision[],
  results: readonly JobResult[],
  unchanged: ReadonlySet<string>,
  limited: readonly MatrixCell[],
  notStarted: ReadonlySet<string>,
): CoverageEntry[] {
  // A file is reviewed when every reviewer assigned to it finished at least
  // one of its tasks: under --ultra one completed sample is enough. A
  // reviewer whose task failed makes the file "failed"; one whose task never
  // started (the task or spend limit, a cancelled run) makes it "unreviewed".
  const done = new Map<string, boolean>();
  const ran = new Set<string>();
  const key = (reviewer: string, file: string) => `${reviewer}\0${file}`;
  for (const { outcome } of results) {
    const started = !notStarted.has(outcome.taskId);
    for (const file of outcome.files) {
      const k = key(outcome.reviewer, file);
      if (started) ran.add(k);
      done.set(k, done.get(k) === true || outcome.status === "completed");
    }
  }
  for (const cell of limited) {
    for (const f of cell.bundle.files) {
      const k = key(cell.reviewer.id, f.newPath);
      if (!done.has(k)) done.set(k, false);
    }
  }
  const status = new Map<string, "reviewed" | "failed" | "unreviewed">();
  for (const [k, completed] of done) {
    const file = at(k.split("\0"), 1);
    const now = completed ? "reviewed" : ran.has(k) ? "failed" : "unreviewed";
    const before = status.get(file);
    // failed outranks unreviewed, which outranks reviewed.
    if (!before || now === "failed" || (now === "unreviewed" && before === "reviewed")) {
      status.set(file, now);
    }
  }
  return decisions.map((d): CoverageEntry => {
    const path = d.diff.newPath;
    if (!d.selected) return { path, status: "excluded", reason: d.reason };
    if (unchanged.has(path)) return { path, status: "unchanged" };
    return { path, status: status.get(path) ?? "unreviewed" };
  });
}
