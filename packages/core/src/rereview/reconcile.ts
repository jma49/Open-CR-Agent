import type { Finding, PriorFinding, PriorReview, Severity } from "../domain.js";
import type { CoverageEntry } from "../pipeline/report.js";

export interface Reconciled {
  findings: Finding[];
  // Reported before, gone now, and their file was reviewed again (or left the change).
  fixed: PriorFinding[];
  // Reported before, but their file was not reviewed this time: status unknown.
  notRechecked: PriorFinding[];
  // Still present, but a person dismissed them and they did not get more severe.
  dismissed: PriorFinding[];
}

const RANK: Record<Severity, number> = { suggestion: 0, warning: 1, critical: 2 };

export function reconcile(
  findings: readonly Finding[],
  prior: PriorReview | undefined,
  coverage: readonly CoverageEntry[],
): Reconciled {
  if (!prior) return { findings: [...findings], fixed: [], notRechecked: [], dismissed: [] };
  const before = new Map(prior.findings.map((f) => [f.fingerprint, f]));
  const now = new Set(findings.map((f) => f.fingerprint));
  const status = new Map(coverage.map((c) => [c.path, c.status]));

  const fixed: PriorFinding[] = [];
  const notRechecked: PriorFinding[] = [];
  for (const old of prior.findings) {
    if (now.has(old.fingerprint)) continue;
    const coverageStatus = status.get(old.file);
    if (coverageStatus === undefined || coverageStatus === "reviewed") fixed.push(old);
    else notRechecked.push(old);
  }

  const kept: Finding[] = [];
  const dismissed: PriorFinding[] = [];
  for (const finding of findings) {
    const old = before.get(finding.fingerprint);
    if (old?.dismissed && RANK[finding.severity] <= RANK[old.severity]) {
      dismissed.push(old);
      continue;
    }
    kept.push({ ...finding, status: old ? "unfixed" : "new" });
  }
  return { findings: kept, fixed, notRechecked, dismissed };
}
