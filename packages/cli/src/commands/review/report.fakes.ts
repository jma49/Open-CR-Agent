import type { Finding, ReviewReport } from "@open-cr-agent/core";

export function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "id",
    fingerprint: "0123456789abcdef",
    reviewer: "correctness",
    category: "correctness",
    severity: "warning",
    file: "src/a.ts",
    existingCode: "x",
    title: "Title",
    body: "Body line 1\nBody line 2",
    evidence: [],
    provenance: { task: "t1" },
    anchor: { method: "hunk", inDiff: true },
    status: "new",
    ...overrides,
  };
}

export const base: ReviewReport = {
  runId: "20261002T070000Z-abcdef",
  changeRequest: {
    id: "1",
    title: "Working tree changes",
    description: "",
    baseSha: "b",
    headSha: "h",
  },
  tier: "lite",
  verdict: "approved",
  summary: "No issues found.",
  coverage: [
    { path: "src/a.ts", status: "reviewed" },
    { path: "yarn.lock", status: "excluded", reason: "generated" },
  ],
  bundles: [],
  skipped: [],
  refuted: [],
  unverifiedCriticals: 0,
  remembered: [],
  tasks: [
    {
      taskId: "correctness-1",
      reviewer: "correctness",
      bundle: "b",
      files: [],
      status: "completed",
      findings: 2,
      durationMs: 1,
      usage: {
        inputTokens: 1200,
        outputTokens: 80,
        reasoningTokens: 0,
        cachedTokens: 0,
        costUsd: 0.01,
      },
    },
  ],
  findings: [],
  usage: {
    inputTokens: 1200,
    outputTokens: 80,
    reasoningTokens: 40,
    cachedTokens: 900,
    costUsd: 0.0031,
  },
  warnings: [],
};
