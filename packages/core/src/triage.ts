import type { FileDiff, RiskTier } from "./domain.js";

export interface TriagePolicy {
  trivialMaxLines: number;
  liteMaxLines: number;
  maxFilesBeforeFull: number;
  sensitivePathPatterns: RegExp[];
}

export const defaultTriagePolicy: TriagePolicy = {
  trivialMaxLines: 10,
  liteMaxLines: 100,
  maxFilesBeforeFull: 20,
  sensitivePathPatterns: [/(^|\/)(auth|crypto|security)(\/|$)/i, /(^|\/)\.github\/workflows\//],
};

export function triage(diffs: readonly FileDiff[], policy = defaultTriagePolicy): RiskTier {
  const touchesSensitivePath = diffs.some((d) =>
    policy.sensitivePathPatterns.some((p) => p.test(d.newPath) || p.test(d.oldPath)),
  );
  if (touchesSensitivePath || diffs.length > policy.maxFilesBeforeFull) return "full";

  const churn = diffs.reduce((sum, d) => sum + d.additions + d.deletions, 0);
  if (churn <= policy.trivialMaxLines) return "trivial";
  if (churn <= policy.liteMaxLines) return "lite";
  return "full";
}
