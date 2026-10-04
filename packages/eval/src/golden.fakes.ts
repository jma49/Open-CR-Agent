import type { OutputFinding } from "@open-cr-agent/core";
import type { InstanceResult } from "./results.js";

export const base = {
  repo: "o/r",
  base: "a".repeat(40),
  head: "b".repeat(40),
  language: "TypeScript",
  tier: "smoke",
  source: { kind: "ocra-history", ref: "r" },
  rationale: "r",
};
export const expectLogin = {
  file: "src/login.ts",
  lines: [10, 12],
  category: "correctness",
  minSeverity: "warning",
  concern: "The session is never cleared.",
};

export function finding(
  fingerprint: string,
  overrides: Partial<OutputFinding> = {},
): OutputFinding {
  return {
    fingerprint,
    reviewer: "correctness",
    category: "correctness",
    severity: "warning",
    verification: "confirmed",
    file: "src/login.ts",
    lines: { start: 40, end: 40 },
    inDiff: true,
    status: "new",
    title: `finding ${fingerprint}`,
    body: "body",
    evidence: [],
    code: "x",
    ...overrides,
  };
}

export const reviewed = (id: string, findings: OutputFinding[]): InstanceResult => ({
  id,
  status: "reviewed",
  durationMs: 1,
  findings,
  usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 },
  tasks: [],
});

// Same file and overlapping lines is enough for this judge.
export const judge = { sameIssue: async () => true };
