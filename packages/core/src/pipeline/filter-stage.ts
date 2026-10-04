import type { PriorReview } from "../domain.js";
import { applyMemory, type MemoryEntry, type RememberedEntry } from "../memory/memory.js";
import { priorCodePresence } from "../rereview/presence.js";
import { type Reconciled, reconcile } from "../rereview/reconcile.js";
import { coverageOf } from "./coverage.js";
import type { ExecuteStage, StageContext } from "./execute-stage.js";
import { dedupeFindings } from "./findings.js";
import { importSarif, type SarifImport } from "./imports.js";
import { type CoverageEntry, coverageGaps } from "./report.js";

export interface FilterStage {
  imported: SarifImport;
  coverage: CoverageEntry[];
  remembered: RememberedEntry[];
  reconciled: Reconciled;
  // No reviewer covered or finished any selected file.
  nothingReviewed: boolean;
  warnings: string[];
}

// Memory and the previous review filter first, so Verify and Judge are not
// paid for findings that will not be reported, and a person's dismissal
// keeps a finding out of the verdict whatever the models say.
export async function filterStage(
  executed: ExecuteStage,
  prior: PriorReview | undefined,
  { options, plan, emit }: StageContext,
): Promise<FilterStage> {
  const imported =
    options.sarif && options.sarif.length > 0
      ? await importSarif(options.sarif, plan, emit)
      : { findings: [], outcomes: [], warnings: [] };
  const { results } = executed;
  const found = dedupeFindings([...results.flatMap((r) => r.findings), ...imported.findings]);
  const coverage = coverageOf(
    plan.decisions,
    results,
    plan.unchanged,
    executed.matrix.limited ?? [],
    executed.notStarted,
  );
  const remembered = applyMemory(found, plan.memory);
  const reported = new Set(found.map((f) => f.fingerprint));
  const priorReview = withoutRemembered(prior, plan.memory);
  const reconciled = reconcile({
    findings: remembered.kept,
    reported,
    prior: priorReview,
    coverage,
    stillPresent: await priorCodePresence(priorReview, reported, plan.context.readFile),
  });
  const { nothingReviewed } = coverageGaps({ coverage, tasks: results.map((r) => r.outcome) });
  return {
    imported,
    coverage,
    remembered: remembered.remembered,
    reconciled,
    nothingReviewed,
    warnings: imported.warnings,
  };
}

// An earlier finding the team has since accepted is no longer open.
function withoutRemembered(
  review: PriorReview | undefined,
  memory: readonly MemoryEntry[],
): PriorReview | undefined {
  if (!review) return undefined;
  const accepted = new Set(memory.map((e) => e.fingerprint));
  // Everything else the earlier review carries (replies, tier, head) stays.
  return { ...review, findings: review.findings.filter((f) => !accepted.has(f.fingerprint)) };
}
