import { describe, expect, it } from "vitest";
import { coverageGaps } from "./report.js";

describe("coverageGaps", () => {
  it("counts failed and unreviewed files and says when nothing was reviewed", () => {
    expect(
      coverageGaps([
        { path: "a.ts", status: "failed" },
        { path: "b.ts", status: "unreviewed" },
        { path: "c.md", status: "excluded", reason: "generated" },
      ]),
    ).toEqual({ notReviewed: 2, nothingReviewed: true });
    expect(
      coverageGaps([
        { path: "a.ts", status: "failed" },
        { path: "b.ts", status: "reviewed" },
      ]),
    ).toEqual({ notReviewed: 1, nothingReviewed: false });
  });

  it("counts files an earlier review covered as reviewed (#208)", () => {
    expect(
      coverageGaps([
        { path: "a.ts", status: "failed" },
        { path: "b.ts", status: "unchanged" },
      ]),
    ).toEqual({ notReviewed: 1, nothingReviewed: false });
  });
});
