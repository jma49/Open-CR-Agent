import type { Usage } from "../contracts.js";

// Review tasks may spend this share of the limit; the rest is kept for Verify
// and Judge, so the run that hits the limit still gets its findings checked.
// Those stages are one short call per file with findings plus one top-tier
// call, while every agent step resends a task's whole conversation, so a fifth
// covers them in typical runs. The reserve also absorbs review tasks that were
// already running when their share ran out.
export const REVIEW_BUDGET_SHARE = 0.8;

export interface SpendTracker {
  // No new review task may start.
  reviewExhausted(): boolean;
  // Nothing more may be spent.
  exhausted(): boolean;
  add(usage: Usage): void;
}

export function spendTracker(
  maxCostUsd: number | undefined,
  initial: readonly Usage[],
): SpendTracker {
  let spent = initial.reduce((sum, u) => sum + u.costUsd, 0);
  const over = (limit: number) => maxCostUsd !== undefined && spent >= limit;
  return {
    reviewExhausted: () => over((maxCostUsd ?? 0) * REVIEW_BUDGET_SHARE),
    exhausted: () => over(maxCostUsd ?? 0),
    add(usage) {
      spent += usage.costUsd;
    },
  };
}
