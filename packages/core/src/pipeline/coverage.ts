import { at } from "../at.js";
import type { IncompleteEnding } from "../contracts.js";
import type { CoverageEntry } from "../report/report.js";
import type { FileDecision } from "../select/select.js";
import type { JobResult } from "./execute.js";
import type { MatrixCell } from "./matrix.js";

// How far one reviewer got with a file, best first: under --ultra one sample
// that called the done tool is enough. Ranked by how actionable it is, a cut-
// off at the step cap above a stop with steps left.
const PROGRESS = ["done", "step_cap", "stopped_early", "none"] as const;
type Progress = (typeof PROGRESS)[number];

type FileStatus =
  | { path: string; status: "reviewed" | "failed" | "unreviewed" }
  | Extract<CoverageEntry, { status: "incomplete" }>;

export function coverageOf(
  decisions: readonly FileDecision[],
  results: readonly JobResult[],
  unchanged: ReadonlySet<string>,
  limited: readonly MatrixCell[],
  notStarted: ReadonlySet<string>,
): CoverageEntry[] {
  // A file is reviewed when every reviewer assigned to it finished at least
  // one of its tasks with the done tool. One whose tasks finished without it
  // makes the file "incomplete"; one whose task failed makes it "failed"; one
  // whose task never started (the task or spend limit, a cancelled run)
  // makes it "unreviewed".
  const progress = new Map<string, Progress>();
  const ran = new Set<string>();
  const key = (reviewer: string, file: string) => `${reviewer}\0${file}`;
  for (const { outcome } of results) {
    const started = !notStarted.has(outcome.taskId);
    const reached: Progress = outcome.status !== "completed" ? "none" : (outcome.ended ?? "done");
    for (const file of outcome.files) {
      const k = key(outcome.reviewer, file);
      if (started) ran.add(k);
      progress.set(k, better(progress.get(k) ?? "none", reached));
    }
  }
  for (const cell of limited) {
    for (const f of cell.bundle.files) {
      const k = key(cell.reviewer.id, f.newPath);
      if (!progress.has(k)) progress.set(k, "none");
    }
  }
  const status = new Map<string, FileStatus>();
  for (const [k, reached] of progress) {
    const path = at(k.split("\0"), 1);
    const now = fileStatus(path, reached, ran.has(k));
    const before = status.get(path);
    if (!before || RANK[now.status] > RANK[before.status]) status.set(path, now);
  }
  return decisions.map((d): CoverageEntry => {
    const path = d.diff.newPath;
    if (!d.selected) return { path, status: "excluded", reason: d.reason };
    if (unchanged.has(path)) return { path, status: "unchanged" };
    return status.get(path) ?? { path, status: "unreviewed" };
  });
}

// A file takes its worst reviewer's status.
const RANK: Record<FileStatus["status"], number> = {
  reviewed: 0,
  unreviewed: 1,
  incomplete: 2,
  failed: 3,
};

function better(a: Progress, b: Progress): Progress {
  return PROGRESS.indexOf(a) <= PROGRESS.indexOf(b) ? a : b;
}

function fileStatus(path: string, reached: Progress, ran: boolean): FileStatus {
  if (reached === "done") return { path, status: "reviewed" };
  if (reached === "none") return { path, status: ran ? "failed" : "unreviewed" };
  return { path, status: "incomplete", ended: reached satisfies IncompleteEnding };
}
