import { describe, expect, it } from "vitest";
import { toPlanOutput } from "./plan-output.js";
import type { ReviewPreview } from "./preview.js";

describe("plan output contract", () => {
  it("pins the plan's keys", () => {
    const preview = {
      changeRequest: { id: "1", title: "t", description: "", baseSha: "b", headSha: "h" },
      tier: "lite",
      selected: [],
      excluded: [],
      bundles: [],
      groupingSkipped: false,
      tasks: [],
      skipped: [],
      promptTokens: 0,
      planCalls: 0,
      warnings: [],
    } as ReviewPreview;
    expect(Object.keys(toPlanOutput(preview)).sort()).toEqual(
      [
        "bundles",
        "changeRequest",
        "excluded",
        "groupingSkipped",
        "planCalls",
        "promptTokens",
        "selected",
        "skipped",
        "tasks",
        "tier",
        "version",
        "warnings",
      ].sort(),
    );
  });
});
