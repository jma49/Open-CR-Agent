// A pre-merge check in plain words, as the team wrote it, and its outcome (ADR-0054).
export interface MergeCheck {
  id: string;
  instruction: string;
}

export const MERGE_CHECK_OUTCOMES = ["passed", "failed", "inconclusive"] as const;
export type MergeCheckOutcome = (typeof MERGE_CHECK_OUTCOMES)[number];

export interface MergeCheckResult extends MergeCheck {
  outcome: MergeCheckOutcome;
  reason: string;
}
