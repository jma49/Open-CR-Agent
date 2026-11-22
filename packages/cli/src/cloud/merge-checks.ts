import {
  MAX_MERGE_CHECKS,
  redactField,
  type SharedMergeCheck,
} from "@open-cr-agent/cloud-contract";
import type { MergeCheckResult } from "@open-cr-agent/core";

// A pull or merge request's check outcomes go with its review (ADR-0054);
// the reasons are model text about the code, so only with the findings.
export function sharedMergeChecks(
  results: readonly MergeCheckResult[],
  withReason: boolean,
): SharedMergeCheck[] {
  return results.slice(0, MAX_MERGE_CHECKS).map((r) => {
    if (!withReason) return { id: r.id, outcome: r.outcome };
    const reason = redactField(r.reason);
    return {
      id: r.id,
      outcome: r.outcome,
      reason: reason.text,
      ...(reason.redacted ? { redacted: true } : {}),
      ...(reason.truncated ? { truncated: true } : {}),
    };
  });
}
