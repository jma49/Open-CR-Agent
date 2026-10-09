import { describe, expect, it } from "vitest";
import type { Usage } from "../contracts.js";
import { REVIEW_SHARE, SpendLimitReached, spendLimit } from "./spend-limit.js";

const cost = (costUsd: number): Usage => ({
  inputTokens: 1,
  outputTokens: 1,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd,
});

describe("spendLimit", () => {
  it("allows everything and reports nothing without a limit", () => {
    const limit = spendLimit(undefined);
    limit.chargeReview(cost(1_000));
    expect(limit.mayStartReview()).toBe(true);
    expect(limit.mayCall()).toBe(true);
    expect(limit.reviewSignal.aborted).toBe(false);
    expect(limit.status()).toBeUndefined();
  });

  it("counts what planning spent before the review", () => {
    const limit = spendLimit(1, [cost(0.5), cost(0.3)]);
    expect(limit.mayStartReview()).toBe(false);
    expect(limit.mayCall()).toBe(true);
  });

  it("stops review tasks once their own spend uses up the review share", () => {
    expect(REVIEW_SHARE).toBe(0.8);
    const limit = spendLimit(1);
    limit.chargeReview(cost(0.5));
    expect(limit.reviewSignal.aborted).toBe(false);
    expect(limit.status()).toEqual({ usd: 1 });
    limit.chargeReview(cost(0.3));
    expect(limit.reviewSignal.reason).toBeInstanceOf(SpendLimitReached);
    expect(limit.reviewSignal.reason.message).toBe("stopped at the spend limit of $1");
    expect(limit.mayStartReview()).toBe(false);
    expect(limit.mayCall()).toBe(true);
    expect(limit.status()).toEqual({ usd: 1, reached: "review" });
  });

  it("does not say the review share stopped review work when only later calls used it up", () => {
    const limit = spendLimit(1);
    limit.chargeReview(cost(0.5));
    limit.charge(cost(0.4));
    expect(limit.reviewSignal.aborted).toBe(false);
    expect(limit.status()).toEqual({ usd: 1 });
  });

  it("says the review share stopped review work when it kept a task from starting", () => {
    const limit = spendLimit(1);
    limit.charge(cost(0.85));
    expect(limit.mayStartReview()).toBe(false);
    expect(limit.status()).toEqual({ usd: 1, reached: "review" });
  });

  it("refuses every further call once the whole limit is spent", () => {
    const limit = spendLimit(1);
    limit.chargeReview(cost(0.7));
    limit.charge(cost(0.3));
    expect(limit.mayCall()).toBe(false);
    expect(limit.status()).toEqual({ usd: 1, reached: "total" });
  });
});
