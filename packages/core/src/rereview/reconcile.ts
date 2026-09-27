import type { Finding, PriorFinding, PriorReview, Severity } from "../domain.js";
import type { CoverageEntry } from "../pipeline/report.js";

export interface ReconcileInput {
  // Findings this run keeps.
  findings: readonly Finding[];
  // Every fingerprint reported this run, including findings later refuted or
  // remembered: those were reproduced, just not kept.
  reported: ReadonlySet<string>;
  prior: PriorReview | undefined;
  coverage: readonly CoverageEntry[];
  // Whether each earlier finding's code is still in its file at head: false
  // when the code or the file is gone, absent when that cannot be told.
  stillPresent: ReadonlyMap<string, boolean>;
}

export interface Reconciled {
  findings: Finding[];
  // Not reported again and their code is gone: the only evidence of a fix.
  fixed: PriorFinding[];
  // Their file was reviewed again and the code is still there, but no reviewer
  // reported them this time. Model runs vary; the finding stays open.
  notReproduced: PriorFinding[];
  // Their file was not reviewed this time: status unknown, the finding stays open.
  notRechecked: PriorFinding[];
  // Their file has not changed since the earlier review, which covered it; the
  // finding carries over as it was.
  unchanged: PriorFinding[];
  // A person dismissed them and they did not come back more severe.
  dismissed: PriorFinding[];
}

const RANK: Record<Severity, number> = { suggestion: 0, warning: 1, critical: 2 };

// Pure: reading files to decide stillPresent happens at the pipeline's edge.
export function reconcile(input: ReconcileInput): Reconciled {
  const { findings, reported, prior, coverage, stillPresent } = input;
  const result: Reconciled = {
    findings: [],
    fixed: [],
    notReproduced: [],
    notRechecked: [],
    unchanged: [],
    dismissed: [],
  };
  if (!prior) {
    result.findings = [...findings];
    return result;
  }
  const before = new Map(prior.findings.map((f) => [f.fingerprint, f]));
  const status = new Map(coverage.map((c) => [c.path, c.status]));

  for (const old of prior.findings) {
    if (reported.has(old.fingerprint)) continue;
    if (stillPresent.get(old.fingerprint) === false) result.fixed.push(old);
    else if (old.dismissed) result.dismissed.push(old);
    else if (status.get(old.file) === "reviewed") result.notReproduced.push(old);
    else if (status.get(old.file) === "unchanged") result.unchanged.push(old);
    else result.notRechecked.push(old);
  }

  for (const finding of findings) {
    const old = before.get(finding.fingerprint);
    if (old?.dismissed && RANK[finding.severity] <= RANK[old.severity]) {
      result.dismissed.push(old);
      continue;
    }
    result.findings.push({
      ...finding,
      status: old ? "unfixed" : "new",
      ...replyFields(prior.replies?.[finding.fingerprint]),
    });
  }
  return result;
}

// Earlier findings that are neither fixed nor dismissed keep counting towards
// the verdict, so the same code reviewed twice cannot flip it by chance.
export function stillOpen(reconciled: Reconciled): PriorFinding[] {
  return [...reconciled.notReproduced, ...reconciled.notRechecked, ...reconciled.unchanged];
}

function replyFields(replies: readonly string[] | undefined): { replies?: string[] } {
  return replies && replies.length > 0 ? { replies: [...replies] } : {};
}
