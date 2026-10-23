import type { FileDiff } from "@open-cr-agent/core";
import type { ReviewPreview } from "@open-cr-agent/core/internal";
import { describe, expect, it } from "vitest";
import { classifyReferences, renderCeiling, summarizeCeiling } from "./ceiling.js";
import type { Instance, ReferenceComment } from "./instance.js";

function ref(path: string, category: string, fromLine: number | null = 10): ReferenceComment {
  return {
    path,
    side: "right",
    fromLine,
    toLine: fromLine,
    note: "n",
    category,
    context: "Diff Level",
  };
}

const instance: Instance = {
  id: "o__r@1",
  repo: "o/r",
  prUrl: "https://github.com/o/r/pull/1",
  language: "TypeScript",
  prCategory: "Feature",
  baseCommit: "b",
  headCommit: "h",
  changeLines: 20,
  references: [
    ref("yarn.lock", "Code Defect"),
    ref("elsewhere.ts", "Code Defect"),
    ref("docs.md", "Code Defect"),
    ref("src/a.ts", "Maintainability and Readability"),
    ref("src/a.ts", "Security Vulnerability"),
    ref("src/a.ts", "Code Defect", 200),
    ref("src/a.ts", "Code Defect", 11),
  ],
};

const preview = {
  selected: ["docs.md", "src/a.ts"],
  excluded: [{ path: "yarn.lock", reason: "generated" }],
  tasks: [
    {
      taskId: "correctness-1",
      reviewer: "correctness",
      bundle: "a",
      files: ["src/a.ts"],
      promptTokens: 1,
    },
  ],
} as unknown as ReviewPreview;

const diffs = [
  {
    newPath: "src/a.ts",
    oldPath: "src/a.ts",
    hunks: [{ oldStart: 8, oldLines: 3, newStart: 8, newLines: 6, header: "", lines: [] }],
  },
] as unknown as FileDiff[];

describe("classifyReferences", () => {
  it("counts a range that overlaps a hunk, not only one inside it", () => {
    const spanning = {
      ...instance,
      references: [{ ...ref("src/a.ts", "Code Defect", 2), toLine: 9 }],
    };
    expect(classifyReferences(spanning, preview, diffs)[0]?.reach).toBe("reachable");
  });

  it("explains what the deterministic stages leave reachable", () => {
    const reaches = classifyReferences(instance, preview, diffs);
    expect(reaches.map((r) => [r.reach, r.detail])).toEqual([
      ["file_excluded", "generated"],
      ["not_in_change", undefined],
      ["no_reviewer", undefined],
      ["out_of_scope", undefined],
      ["no_domain_reviewer", "security"],
      ["outside_diff", undefined],
      ["reachable", undefined],
    ]);
    const summary = summarizeCeiling("aacr", reaches, ["lite"]);
    expect(summary.byReach.reachable).toBe(1);
    expect(summary.byTier).toEqual({ trivial: 0, lite: 1, full: 0 });
    expect(summary.excludedBy).toEqual({ generated: 1 });
    expect(renderCeiling(summary)).toContain(
      "# Recall ceiling, AACR-Bench\n\n7 annotated issues in 1 PR(s),",
    );
    expect(renderCeiling(summary)).toContain("Risk tiers: trivial 0, lite 1, full 0.");
    expect(renderCeiling(summary)).toContain(
      "Upper bound on recall: **14.3%** reachable, **28.6%**",
    );
  });

  it("names golden cases as cases with required claims", () => {
    const summary = summarizeCeiling("golden", classifyReferences(instance, preview, diffs), [
      "lite",
    ]);
    expect(renderCeiling(summary)).toContain(
      "# Recall ceiling, golden cases\n\n7 required claims in 1 case(s),",
    );
  });

  it("keys golden claims by id and leaves optional ones out of the bound", () => {
    const golden: Instance = {
      ...instance,
      references: [ref("src/a.ts", "Code Defect", 11), ref("src/a.ts", "Code Defect", 200)],
      golden: {
        tier: "smoke",
        clean: false,
        forbid: [],
        adjudicated: [],
        claims: [
          { id: "in-diff", optional: false },
          { id: "pre-existing", optional: true },
        ],
        minSeverity: ["suggestion", "suggestion"],
        alternates: [[], []],
      },
    };
    const reaches = classifyReferences(golden, preview, diffs);
    expect(reaches.map((r) => [r.claim, r.optional, r.reach])).toEqual([
      ["in-diff", undefined, "reachable"],
      ["pre-existing", true, "outside_diff"],
    ]);
    const summary = summarizeCeiling("golden", reaches, ["lite"]);
    expect([summary.references, summary.optional, summary.byReach.outside_diff]).toEqual([1, 1, 0]);
    expect(renderCeiling(summary)).toContain(
      "1 required claims in 1 case(s) (and 1 optional ones, which recall does not count)",
    );
  });
});
