import type { Usage } from "../contracts.js";
import { OcraError } from "../errors.js";

// Review tasks may spend this share of the limit; the rest is kept for Verify
// and Judge, so the run that hits the limit still gets its findings checked.
// Those stages are one short call per file with findings plus one top-tier
// call, while every agent step resends a task's whole conversation, so a fifth
// covers them in typical runs. Review tasks still running when their share
// runs out are stopped; what they spend while stopping (the step in flight,
// and whatever the runtime had not reported yet) comes out of the reserve.
export const REVIEW_SHARE = 0.8;

// Why running review tasks were stopped.
export class SpendLimitReached extends OcraError {
  constructor(maxCostUsd: number) {
    super("BUDGET_EXHAUSTED", `stopped at the spend limit of $${maxCostUsd}`);
    this.name = "SpendLimitReached";
  }
}

// A run's spend limit (ADR-0015): every model call is charged to it, and the
// stages ask it before they spend. Without a limit everything is allowed and
// nothing is reported.
export interface SpendLimit {
  readonly usd: number | undefined;
  // Review tasks and their plan calls run under it: aborted with
  // SpendLimitReached once their own spend uses up the review share, so the
  // task that does stops every task still running.
  readonly reviewSignal: AbortSignal;
  // What review tasks and their plan calls spend, as they report it.
  chargeReview(usage: Usage): void;
  // What every other call spends: grouping, relocation, Verify, Judge.
  charge(usage: Usage): void;
  // Whether another review task may start. A refusal counts as the limit
  // having stopped review work.
  mayStartReview(): boolean;
  // Whether a call outside the review tasks may still be made.
  mayCall(): boolean;
  // What the report says: "review" when the review share stopped review
  // tasks or kept one from starting, "total" when the whole limit ran out.
  status(): { usd: number; reached?: "review" | "total" } | undefined;
}

export function spendLimit(
  maxCostUsd: number | undefined,
  initial: readonly Usage[] = [],
): SpendLimit {
  let spent = initial.reduce((sum, u) => sum + u.costUsd, 0);
  let refusedReview = false;
  const stop = new AbortController();
  const over = (share: number) => maxCostUsd !== undefined && spent >= maxCostUsd * share;
  return {
    usd: maxCostUsd,
    reviewSignal: stop.signal,
    chargeReview(usage) {
      spent += usage.costUsd;
      if (maxCostUsd !== undefined && over(REVIEW_SHARE) && !stop.signal.aborted) {
        stop.abort(new SpendLimitReached(maxCostUsd));
      }
    },
    charge(usage) {
      spent += usage.costUsd;
    },
    mayStartReview() {
      if (!over(REVIEW_SHARE)) return true;
      refusedReview = true;
      return false;
    },
    mayCall: () => !over(1),
    status() {
      if (maxCostUsd === undefined) return undefined;
      const reached = over(1)
        ? "total"
        : stop.signal.aborted || refusedReview
          ? "review"
          : undefined;
      return { usd: maxCostUsd, ...(reached ? { reached } : {}) };
    },
  };
}
