import { describe, expect, it } from "vitest";
import { coverageGaps } from "./report.js";

describe("coverageGaps", () => {
  it("counts failed and unreviewed files and says when nothing was reviewed", () => {
    expect(
      coverageGaps({
        coverage: [
          { path: "a.ts", status: "failed" },
          { path: "b.ts", status: "unreviewed" },
          { path: "c.md", status: "excluded", reason: "generated" },
        ],
        tasks: [{ status: "failed" }],
      }),
    ).toEqual({ notReviewed: 2, nothingReviewed: true });
    expect(
      coverageGaps({
        coverage: [
          { path: "a.ts", status: "failed" },
          { path: "b.ts", status: "reviewed" },
        ],
        tasks: [{ status: "failed" }, { status: "completed" }],
      }),
    ).toEqual({ notReviewed: 1, nothingReviewed: false });
  });

  it("counts files an earlier review covered as reviewed (#208)", () => {
    expect(
      coverageGaps({
        coverage: [
          { path: "a.ts", status: "failed" },
          { path: "b.ts", status: "unchanged" },
        ],
        tasks: [{ status: "failed" }],
      }),
    ).toEqual({ notReviewed: 1, nothingReviewed: false });
  });

  it("counts a reviewer that finished its tasks, even when another failed on the same files (#263)", () => {
    expect(
      coverageGaps({
        coverage: [{ path: "a.ts", status: "failed" }],
        tasks: [{ status: "completed" }, { status: "failed" }],
      }),
    ).toEqual({ notReviewed: 1, nothingReviewed: false });
  });
});
