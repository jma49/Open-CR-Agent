import type { Finding, PriorFinding, PriorReview } from "../domain.js";
import type { CoverageEntry } from "../pipeline/report.js";

export interface Reconciled {
  findings: Finding[];
  // Reported before, gone now, and their file was reviewed again (or left the change).
  fixed: PriorFinding[];
  // Reported before, but their file was not reviewed this time: status unknown.
  notRechecked: PriorFinding[];
}

export function reconcile(
  findings: readonly Finding[],
  prior: PriorReview | undefined,
  coverage: readonly CoverageEntry[],
): Reconciled {
  if (!prior) return { findings: [...findings], fixed: [], notRechecked: [] };
  const before = new Set(prior.findings.map((f) => f.fingerprint));
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
  return {
    findings: findings.map((f) => ({
      ...f,
      status: before.has(f.fingerprint) ? "unfixed" : "new",
    })),
    fixed,
    notRechecked,
  };
}
