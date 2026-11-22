import { describe, expect, it } from "vitest";
import { contextFootprint } from "../pipeline/context-footprint.js";
import { contextInput } from "./context.fakes.js";
import type { ContextSource } from "./context-sources.js";
import { reviewPromptParts } from "./prompt.js";

// The most tokens each source may add to one review prompt, however large
// its input grows (ADR-0057). Lower a budget when a source tightens; raise
// one only with the measurement that justifies it.
const BUDGETS: Partial<Record<ContextSource, number>> = {
  change_request: 2_150,
  changed_files: 2_000,
  linked_tasks: 6_100,
  guidelines: 5_050,
  rules: 3_100,
  accepted: 2_350,
  learnings: 3_400,
  project_docs: 2_500,
  callers: 4_800,
  analyzer: 2_050,
};
const TOTAL_BUDGET = 34_000;

describe("context budgets", () => {
  const largest = contextFootprint(reviewPromptParts(contextInput("largest")));

  it.each(Object.entries(BUDGETS))("holds %s to %i tokens", (source, budget) => {
    const part = largest.find((p) => p.source === source);
    expect(part, `${source} is in the prompt`).toBeDefined();
    expect(part?.tokens).toBeLessThanOrEqual(budget);
  });

  it("holds the context around the diff to its total", () => {
    const context = largest.filter((p) => p.source in BUDGETS);
    expect(context.reduce((sum, p) => sum + p.tokens, 0)).toBeLessThanOrEqual(TOTAL_BUDGET);
  });

  it("marks every source it cuts", () => {
    const cut = largest.filter((p) => (p.cut ?? 0) > 0).map((p) => p.source);
    expect(cut).toEqual(
      expect.arrayContaining(["changed_files", "accepted", "rules", "guidelines", "linked_tasks"]),
    );
  });

  it("shows small inputs whole", () => {
    const small = contextFootprint(reviewPromptParts(contextInput("small")));
    expect(small.filter((p) => p.cut)).toEqual([]);
  });
});
