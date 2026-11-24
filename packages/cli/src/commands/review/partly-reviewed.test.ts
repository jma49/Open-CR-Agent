import { describe, expect, it } from "vitest";
import { partlyReviewed, partlyReviewedCount } from "./partly-reviewed.js";

describe("partlyReviewed", () => {
  it("says one sentence per way a task was cut short, with what to do", () => {
    const lines = partlyReviewed({ step_cap: 2, context_window: 3, stopped_early: 1 });
    expect(lines).toEqual([
      expect.stringMatching(/^2 selected file\(s\) .* used all 30 of its steps/),
      "3 selected file(s) were only partly reviewed, so the review is incomplete: a reviewer filled its model's context window before it finished them. Review a smaller change, or use a model with a larger window.",
      expect.stringMatching(/^1 selected file\(s\) .* stopped with steps left/),
    ]);
  });

  it("says nothing for a way that cut no task short", () => {
    const incomplete = { step_cap: 0, context_window: 4, stopped_early: 0 };
    expect(partlyReviewed(incomplete)).toHaveLength(1);
    expect(partlyReviewedCount(incomplete)).toBe(4);
  });
});
