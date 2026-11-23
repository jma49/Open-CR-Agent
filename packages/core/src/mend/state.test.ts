import { describe, expect, it } from "vitest";
import { closedAs, EMPTY_STATE, MEND_LIMITS, roundStop } from "./state.js";

describe("the loop's caps", () => {
  it("stops a change request at its rounds and at its spend limit", () => {
    expect(roundStop(EMPTY_STATE, 1)).toBeUndefined();
    expect(roundStop({ ...EMPTY_STATE, rounds: MEND_LIMITS.rounds }, undefined)).toBe("rounds");
    expect(roundStop({ ...EMPTY_STATE, costUsd: 1 }, 1)).toBe("spend");
    expect(roundStop({ ...EMPTY_STATE, costUsd: 5 }, undefined)).toBeUndefined();
  });

  it("closes an item for a person once its attempts are used", () => {
    expect(closedAs(undefined)).toBeUndefined();
    expect(closedAs({ attempts: 1 })).toBeUndefined();
    expect(closedAs({ attempts: MEND_LIMITS.attemptsPerItem })).toBe("needs_human");
    expect(closedAs({ attempts: 1, closed: "gone" })).toBe("gone");
  });
});
