import type { Finding, ReviewReport } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { renderJson, renderText } from "./render.js";

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "id",
    fingerprint: "fp",
    reviewer: "correctness",
    category: "correctness",
    severity: "warning",
    file: "src/a.ts",
    existingCode: "x",
    title: "Title",
    body: "Body line 1\nBody line 2",
    evidence: [],
    anchor: { method: "hunk", inDiff: true },
    status: "new",
    ...overrides,
  };
}

const base: ReviewReport = {
  changeRequest: {
    id: "1",
    title: "Working tree changes",
    description: "",
    baseSha: "b",
    headSha: "h",
  },
  tier: "lite",
  coverage: [
    { path: "src/a.ts", status: "reviewed" },
    { path: "yarn.lock", status: "excluded", reason: "generated" },
  ],
  bundles: [],
  tasks: [
    {
      taskId: "correctness-1",
      reviewer: "correctness",
      bundle: "b",
      files: [],
      status: "completed",
      findings: 2,
      durationMs: 1,
    },
  ],
  findings: [],
  usage: {
    inputTokens: 1200,
    outputTokens: 80,
    reasoningTokens: 40,
    cachedTokens: 900,
    costUsd: 0.0031,
  },
  warnings: [],
};

describe("renderText", () => {
  it("renders findings grouped by file with locations", () => {
    const report = {
      ...base,
      findings: [
        finding({ severity: "critical", lineRange: { start: 3, end: 5 }, suggestion: "Guard it." }),
        finding({ file: "src/b.ts", lineRange: { start: 7, end: 7 } }),
        finding({ file: "src/b.ts", title: "File-level" }),
      ],
      warnings: ["grouping failed"],
    };
    expect(renderText(report, ".ocra/sessions/s1")).toBe(
      [
        "Review: Working tree changes",
        "Risk tier: lite · 1 reviewed · 0 failed · 1 excluded",
        "",
        "src/a.ts",
        "  critical   L3-5      Title",
        "    Body line 1",
        "    Body line 2",
        "    Suggestion: Guard it.",
        "",
        "src/b.ts",
        "  warning    L7        Title",
        "    Body line 1",
        "    Body line 2",
        "  warning    file      File-level",
        "    Body line 1",
        "    Body line 2",
        "",
        "3 finding(s) (1 critical, 2 warning, 0 suggestion) · tokens: 1200 in (900 cached), 80 out, 40 reasoning · $0.0031",
        "Warning: grouping failed",
        "Session: .ocra/sessions/s1",
        "",
      ].join("\n"),
    );
  });

  it("says when nothing was found and flags incomplete runs", () => {
    const report: ReviewReport = {
      ...base,
      tasks: [
        ...base.tasks,
        { ...base.tasks[0], taskId: "correctness-2", status: "failed", error: "x" } as never,
      ],
    };
    const text = renderText(report);
    expect(text).toContain("No issues found in the files that were reviewed.");
    expect(text).toContain("Incomplete: 1 of 2 review task(s) did not finish.");
    expect(renderText(base)).toContain("No issues found.\n");
  });

  it("never claims a clean result when nothing was reviewed", () => {
    const report: ReviewReport = {
      ...base,
      tasks: [{ ...base.tasks[0], status: "failed" } as never],
    };
    expect(renderText(report)).toContain("Nothing was reviewed: no review task completed.");
    expect(renderText(report)).not.toContain("No issues found");
  });
});

describe("renderJson", () => {
  it("renders the full report", () => {
    expect(JSON.parse(renderJson(base))).toEqual(base);
  });
});
