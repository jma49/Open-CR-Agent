import type { ReviewReport } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { checkOutcome, runningOutcome, stoppedOutcome } from "./check.js";
import { finding, HEAD, report } from "./conformance.fakes.js";

describe("checkOutcome", () => {
  it("passes an approval and counts what it found", () => {
    const outcome = checkOutcome(report([finding("a".repeat(16))]));
    expect(outcome.conclusion).toBe("success");
    expect(outcome.title).toBe("Approved with comments · 1 warning");
  });

  it("names the coding agent that ran the review, after ocra", () => {
    const byAgent = { ...report([finding("a".repeat(16))]), agent: "Codex" };
    expect(checkOutcome(byAgent).title).toBe("ocra · Codex · Approved with comments · 1 warning");
  });

  it("stays neutral on issues, so the check never blocks a merge", () => {
    const blocking: ReviewReport = {
      ...report([finding("a".repeat(16), { severity: "critical" })]),
      verdict: "significant_concerns",
    };
    expect(checkOutcome(blocking).conclusion).toBe("neutral");
    expect(checkOutcome({ ...blocking, verdict: "minor_issues" }).conclusion).toBe("neutral");
    const overridden = {
      ...blocking,
      changeRequest: { ...blocking.changeRequest, override: { by: "lead", reason: "ok" } },
    };
    expect(checkOutcome(overridden).conclusion).toBe("success");
  });

  it("lists the findings in one table, most severe first, with cells that cannot break it", () => {
    const outcome = checkOutcome(
      report([
        finding("a".repeat(16), { severity: "suggestion", title: "Tidy" }),
        finding("b".repeat(16), {
          severity: "critical",
          title: "Breaks | the table\nand the line",
          lineRange: { start: 3, end: 5 },
        }),
      ]),
    );
    const rows = outcome.summary.split("\n");
    expect(rows.slice(0, 2)).toEqual(["| Severity | Where | Finding |", "|---|---|---|"]);
    expect(rows[2]).toMatch(
      /^\| 🔴 Critical \| `src\/login\.ts:3-5` \| Breaks \\\| the table and the line \|$/,
    );
    expect(rows[3]).toContain("🔵 Suggestion");
    expect(outcome.title).toBe("Approved with comments · 1 critical, 1 suggestion");
  });

  it("caps the table and points to the summary for the rest", () => {
    const many = Array.from({ length: 52 }, (_, i) => finding(i.toString(16).padStart(16, "0")));
    const { summary } = checkOutcome(report(many));
    expect(summary.split("\n").filter((l) => l.startsWith("| 🟠"))).toHaveLength(50);
    expect(summary).toContain("2 more in the summary comment.");
  });

  it("says nothing was reviewed instead of a verdict", () => {
    const outcome = checkOutcome({
      ...report([]),
      coverage: [{ path: "src/login.ts", status: "unreviewed" }],
    });
    expect(outcome).toMatchObject({ conclusion: "neutral", title: "Not reviewed" });
  });

  it("reports a clean review without a table", () => {
    expect(checkOutcome(report([]))).toEqual({
      conclusion: "success",
      title: "Approved · no issues",
      summary: "No issues found.",
    });
  });
});

describe("running and stopped", () => {
  it("names the commit under review and a stop's reason", () => {
    expect(runningOutcome(HEAD).summary).toContain("`ccccccc`");
    expect(stoppedOutcome("The review failed: quota\nreached")).toEqual({
      conclusion: "cancelled",
      title: "Stopped",
      summary: "The review failed: quota reached",
    });
  });
});
