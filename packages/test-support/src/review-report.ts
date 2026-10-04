import type { Finding, PriorFinding, ReviewReport, TaskOutcome, Usage } from "@open-cr-agent/core";

// Complete, valid values of core's report types for tests: a test names only
// the fields it is about, and the type checker still sees a whole report.

export function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    ...overrides,
  };
}

export function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    fingerprint: "0123456789abcdef",
    reviewer: "correctness",
    category: "bug",
    severity: "warning",
    file: "src/a.ts",
    existingCode: "a()",
    title: "A finding",
    body: "What is wrong.",
    evidence: [],
    provenance: { task: "correctness-1" },
    anchor: { method: "hunk", inDiff: true },
    status: "new",
    ...overrides,
  };
}

export function priorFinding(overrides: Partial<PriorFinding> = {}): PriorFinding {
  return {
    fingerprint: "0123456789abcdef",
    title: "A finding",
    file: "src/a.ts",
    severity: "warning",
    commented: false,
    ...overrides,
  };
}

export function taskOutcome(overrides: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    taskId: "correctness-1",
    reviewer: "correctness",
    bundle: "b1",
    files: [],
    status: "completed",
    findings: 0,
    durationMs: 0,
    usage: usage(),
    ...overrides,
  };
}

export function reviewReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    runId: "20260101T000000Z-abcdef",
    changeRequest: { id: "1", title: "t", description: "", baseSha: "b", headSha: "h" },
    tier: "full",
    verdict: "approved",
    summary: "",
    coverage: [],
    bundles: [],
    tasks: [],
    skipped: [],
    findings: [],
    unverifiedCriticals: 0,
    refuted: [],
    remembered: [],
    usage: usage(),
    warnings: [],
    ...overrides,
  };
}
