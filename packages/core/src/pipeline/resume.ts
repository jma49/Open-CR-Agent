import type { Bundle } from "../bundle/bundle.js";
import type { FileDiff, TaskFinding } from "../domain.js";
import type { TaskOutcome } from "../report/report.js";

// An earlier run of the same review whose completed tasks a retry reuses
// instead of paying for them again (ADR-0031): what `ocra review --resume`
// reads back from that run's session.
export interface ResumedRun {
  runId: string;
  // The earlier run's bundles; reused when they cover exactly the files in
  // scope, so the grouping call and its variance do not change the tasks.
  bundles: readonly { label: string; files: readonly string[] }[];
  tasks: readonly ResumedTask[];
}

// A task of the earlier run that completed, with what it reported before
// anchoring. Its key hashes everything the task's answer depends on.
export interface ResumedTask {
  key: string;
  outcome: TaskOutcome;
  findings: readonly TaskFinding[];
}

// The earlier run's bundles, when they hold exactly the files in scope;
// otherwise undefined and the files are bundled again.
export function resumedBundles(
  run: ResumedRun,
  inScope: readonly FileDiff[],
): Bundle[] | undefined {
  const byPath = new Map(inScope.map((d) => [d.newPath, d]));
  const listed = run.bundles.flatMap((b) => b.files);
  if (listed.length !== byPath.size || new Set(listed).size !== listed.length) return undefined;
  if (!listed.every((path) => byPath.has(path))) return undefined;
  return run.bundles.map((b) => ({
    label: b.label,
    files: b.files.map((path) => byPath.get(path) as FileDiff),
  }));
}

// Each earlier task is reused at most once: --ultra's two samples of a cell
// share a key and take one earlier sample each.
export interface ReusePool {
  take(key: string): ResumedTask | undefined;
  // Earlier completed tasks no cell of this run matched.
  unused(): number;
}

export function reusePool(run: ResumedRun | undefined): ReusePool {
  const byKey = new Map<string, ResumedTask[]>();
  for (const task of run?.tasks ?? []) {
    byKey.set(task.key, [...(byKey.get(task.key) ?? []), task]);
  }
  return {
    take: (key) => byKey.get(key)?.shift(),
    unused: () => [...byKey.values()].reduce((n, tasks) => n + tasks.length, 0),
  };
}
