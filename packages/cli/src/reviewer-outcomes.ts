import type { Severity, TaskStatus, Verification } from "@open-cr-agent/core";

// What a report holds that the per-reviewer counts read; both the domain
// report (the ocra Cloud upload) and the JSON report (`ocra metrics`) have it.
export interface CountedReport {
  tasks: readonly {
    reviewer: string;
    status: TaskStatus;
    usage: { costUsd: number };
    reusedFrom?: string | undefined;
  }[];
  findings: readonly {
    reviewer: string;
    severity: Severity;
    fingerprint: string;
    verification?: Verification | undefined;
  }[];
  rereview?:
    | {
        fixed: readonly { fingerprint: string; reviewer?: string | undefined }[];
        dismissed: readonly { fingerprint: string; reviewer?: string | undefined }[];
      }
    | undefined;
}

interface ReviewerOutcome {
  tasks: number;
  failedTasks: number;
  findings: Record<Severity, number>;
  costUsd: number;
  fixed: number;
  dismissed: number;
}

export interface ReviewOutcomes {
  // By reviewer id, in id order.
  reviewers: Record<string, ReviewerOutcome>;
  verification: Record<Verification, number>;
  // Earlier findings gone from the code or dismissed, each fingerprint once.
  fixed: number;
  dismissed: number;
}

// The per-reviewer counts of one report (the upload) or of many (`ocra
// metrics`), counted one way: a failed or timed-out task is failed; a reused
// task's cost is the run's that paid for it; a finding without a
// verification is unchecked; a dismissal outranks a fix, in any report; and
// a fixed or dismissed finding counts for the reviewer the earlier review
// recorded for it, else the first that reported its fingerprint, else none.
export function reviewerOutcomes(reports: readonly CountedReport[]): ReviewOutcomes {
  const reviewers = new Map<string, ReviewerOutcome>();
  const of = (id: string): ReviewerOutcome => {
    let r = reviewers.get(id);
    if (!r) {
      r = {
        tasks: 0,
        failedTasks: 0,
        findings: { critical: 0, warning: 0, suggestion: 0 },
        costUsd: 0,
        fixed: 0,
        dismissed: 0,
      };
      reviewers.set(id, r);
    }
    return r;
  };
  const verification: Record<Verification, number> = { confirmed: 0, uncertain: 0, unchecked: 0 };
  const reporter = new Map<string, string>();
  const recorded = new Map<string, string>();
  const fixed = new Set<string>();
  const dismissed = new Set<string>();
  const record = (f: { fingerprint: string; reviewer?: string | undefined }) => {
    if (f.reviewer && !recorded.has(f.fingerprint)) recorded.set(f.fingerprint, f.reviewer);
  };
  for (const report of reports) {
    for (const task of report.tasks) {
      const r = of(task.reviewer);
      r.tasks += 1;
      if (task.status === "failed" || task.status === "timed_out") r.failedTasks += 1;
      if (task.reusedFrom === undefined) r.costUsd += task.usage.costUsd;
    }
    for (const finding of report.findings) {
      of(finding.reviewer).findings[finding.severity] += 1;
      verification[finding.verification ?? "unchecked"] += 1;
      if (!reporter.has(finding.fingerprint)) reporter.set(finding.fingerprint, finding.reviewer);
    }
    for (const f of report.rereview?.fixed ?? []) {
      fixed.add(f.fingerprint);
      record(f);
    }
    for (const f of report.rereview?.dismissed ?? []) {
      dismissed.add(f.fingerprint);
      record(f);
    }
  }
  for (const fp of dismissed) fixed.delete(fp);
  const credited = (fp: string) => recorded.get(fp) ?? reporter.get(fp);
  for (const fp of fixed) {
    const reviewer = credited(fp);
    if (reviewer) of(reviewer).fixed += 1;
  }
  for (const fp of dismissed) {
    const reviewer = credited(fp);
    if (reviewer) of(reviewer).dismissed += 1;
  }
  return {
    reviewers: Object.fromEntries([...reviewers].sort(([a], [b]) => a.localeCompare(b))),
    verification,
    fixed: fixed.size,
    dismissed: dismissed.size,
  };
}
