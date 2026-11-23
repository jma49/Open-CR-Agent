import type { Finding, PriorReview } from "../domain.js";
import { protectedFinding } from "../judge/judge.js";
import type { MatrixCell } from "../matrix/matrix.js";
import type { MemoryEntry } from "../memory/memory.js";
import { staysDismissed } from "../rereview/reconcile.js";
import { type EarlyVerification, earlyVerifier } from "../verify/early.js";
import type { FileVerification, VerifyOptions } from "../verify/verify.js";
import type { StageContext } from "./execute-stage.js";
import { dedupeFindings } from "./findings.js";

// Findings checked while review tasks still run (ADR-0074). A file's findings
// go to the verifier once every task reviewing that file has ended, and the
// critical ones it confirms are settled: the report carries them as they
// are, so a watcher can be shown them before the run ends.

interface EarlyResult {
  verification: EarlyVerification;
  // Ids of the settled findings.
  settled: ReadonlySet<string>;
}

export interface EarlyCheck {
  // Ids verification already has: the run keeps those copies of a finding.
  readonly submitted: ReadonlySet<string>;
  taskEnded(cell: MatrixCell, findings: readonly Finding[]): void;
  result(): Promise<EarlyResult>;
}

// Undefined when the run does not verify.
export function earlyCheck(
  cells: readonly MatrixCell[],
  verify: VerifyOptions,
  { settings, plan, emit }: StageContext,
): EarlyCheck | undefined {
  if (!settings.verify) return undefined;
  const settled = new Set<string>();
  const verifier = earlyVerifier(verify, (file, verified) => {
    const now = settle(verified, settings.showPreExisting);
    for (const f of now) settled.add(f.id);
    emit({
      type: "findings_verified",
      file,
      kept: verified.kept,
      refuted: verified.refuted.map((r) => r.finding.id),
      settled: now.map((f) => f.id),
    });
  });
  if (!verifier) return undefined;
  const reportable = keptByPeople(plan.prior.review, plan.memory);
  const order = new Map(cells.map((cell, index) => [cell.taskId, index]));
  const open = openTasks(cells);
  const found = new Map<string, { at: number; finding: Finding }[]>();
  return {
    submitted: verifier.submitted,
    taskEnded(cell, findings) {
      const at = order.get(cell.taskId) ?? cells.length;
      for (const finding of findings) {
        // A file checked already keeps its answer: a finding that names it
        // later waits for Verify.
        if (open.has(finding.file)) {
          found.set(finding.file, [...(found.get(finding.file) ?? []), { at, finding }]);
        }
      }
      for (const { newPath } of cell.bundle.files) {
        const tasks = open.get(newPath);
        tasks?.delete(cell.taskId);
        if (tasks?.size !== 0) continue;
        open.delete(newPath);
        // In the tasks' order, as Verify would see them.
        const group = dedupeFindings(
          (found.get(newPath) ?? []).sort((a, b) => a.at - b.at).map((f) => f.finding),
        ).filter(reportable);
        if (group.length > 0) verifier.verify(newPath, group);
      }
    },
    result: async () => ({ verification: await verifier.result(), settled }),
  };
}

// The tasks still to end, by file they review.
function openTasks(cells: readonly MatrixCell[]): Map<string, Set<string>> {
  const open = new Map<string, Set<string>>();
  for (const cell of cells) {
    for (const { newPath } of cell.bundle.files) {
      open.set(newPath, (open.get(newPath) ?? new Set()).add(cell.taskId));
    }
  }
  return open;
}

// What memory and a person's dismissal leave of the findings (filter-stage.ts
// applies both to the whole run); neither is worth a verifier call.
function keptByPeople(
  prior: PriorReview | undefined,
  memory: readonly MemoryEntry[],
): (finding: Finding) => boolean {
  const accepted = new Set(memory.map((e) => e.fingerprint));
  const before = new Map(prior?.findings.map((f) => [f.fingerprint, f]));
  return (finding) => {
    if (accepted.has(finding.fingerprint)) return false;
    const old = before.get(finding.fingerprint);
    return !(old && staysDismissed(finding, old));
  };
}

// The judge can neither drop nor downgrade a confirmed critical finding, but
// it may merge two that say the same thing; of findings on overlapping lines
// only the first is settled, and the others wait for it.
function settle(verified: FileVerification, showPreExisting: boolean): Finding[] {
  const settled: Finding[] = [];
  for (const finding of verified.kept) {
    if (!protectedFinding(finding)) continue;
    if (finding.preExisting && !showPreExisting) continue;
    if (!settled.some((other) => overlap(other, finding))) settled.push(finding);
  }
  return settled;
}

function overlap(a: Finding, b: Finding): boolean {
  if (!a.lineRange || !b.lineRange) return true;
  return a.lineRange.start <= b.lineRange.end && b.lineRange.start <= a.lineRange.end;
}
