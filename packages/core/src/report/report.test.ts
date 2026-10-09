import { describe, expect, it } from "vitest";
import { coverageGaps, isBlocking, isIncompleteReview, unconfirmedCriticals } from "./report.js";

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
    ).toEqual({
      notReviewed: 2,
      nothingReviewed: true,
      incomplete: { step_cap: 0, stopped_early: 0 },
    });
    expect(
      coverageGaps({
        coverage: [
          { path: "a.ts", status: "failed" },
          { path: "b.ts", status: "reviewed" },
        ],
        tasks: [{ status: "failed" }, { status: "completed" }],
      }),
    ).toMatchObject({ notReviewed: 1, nothingReviewed: false });
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
    ).toMatchObject({ notReviewed: 1, nothingReviewed: false });
  });

  it("counts a reviewer that finished its tasks, even when another failed on the same files (#263)", () => {
    expect(
      coverageGaps({
        coverage: [{ path: "a.ts", status: "failed" }],
        tasks: [{ status: "completed" }, { status: "failed" }],
      }),
    ).toMatchObject({ notReviewed: 1, nothingReviewed: false });
  });

  it("counts files only partly reviewed as not reviewed, by how their task ended", () => {
    expect(
      coverageGaps({
        coverage: [
          { path: "a.ts", status: "incomplete", ended: "step_cap" },
          { path: "b.ts", status: "incomplete", ended: "step_cap" },
          { path: "c.ts", status: "incomplete", ended: "stopped_early" },
          { path: "d.ts", status: "reviewed" },
        ],
        tasks: [{ status: "completed" }],
      }),
    ).toEqual({
      notReviewed: 3,
      nothingReviewed: false,
      incomplete: { step_cap: 2, stopped_early: 1 },
    });
  });
});

describe("isIncompleteReview", () => {
  const reviewed = [{ path: "a.ts", status: "reviewed" as const }];

  it("is incomplete with an unfinished file or an unverified critical finding, and only then", () => {
    expect(isIncompleteReview({ coverage: reviewed, unverifiedCriticals: 0 })).toBe(false);
    expect(isIncompleteReview({ coverage: reviewed, unverifiedCriticals: 1 })).toBe(true);
    for (const coverage of [
      [{ path: "a.ts", status: "failed" as const }],
      [{ path: "a.ts", status: "unreviewed" as const }],
      [{ path: "a.ts", status: "incomplete" as const, ended: "step_cap" as const }],
    ]) {
      expect(isIncompleteReview({ coverage, unverifiedCriticals: 0 })).toBe(true);
    }
    expect(
      isIncompleteReview({
        coverage: [
          { path: "a.ts", status: "unchanged" },
          { path: "b.md", status: "excluded", reason: "generated" },
        ],
        unverifiedCriticals: 0,
      }),
    ).toBe(false);
  });
});

describe("isBlocking", () => {
  it("blocks on significant concerns no one overrode", () => {
    expect(isBlocking({ verdict: "significant_concerns", changeRequest: {} })).toBe(true);
    expect(
      isBlocking({
        verdict: "significant_concerns",
        changeRequest: { override: { by: "maintainer", reason: "known" } },
      }),
    ).toBe(false);
    expect(isBlocking({ verdict: "minor_issues", changeRequest: {} })).toBe(false);
  });
});

describe("unconfirmedCriticals", () => {
  const critical = (
    verification?: "confirmed" | "uncertain" | "unchecked",
    lowConfidence = false,
  ) =>
    ({
      severity: "critical",
      ...(verification ? { verification } : {}),
      ...(lowConfidence ? { lowConfidence } : {}),
    }) as const;

  it("counts the critical findings that cap the verdict, not low-confidence ones", () => {
    expect(
      unconfirmedCriticals({
        verdict: "minor_issues",
        findings: [critical("uncertain"), critical(), critical("unchecked", true)],
      }),
    ).toBe(2);
  });

  it("is zero while a confirmed critical finding blocks", () => {
    expect(
      unconfirmedCriticals({
        verdict: "significant_concerns",
        findings: [critical("confirmed"), critical("uncertain")],
      }),
    ).toBe(0);
  });
});
