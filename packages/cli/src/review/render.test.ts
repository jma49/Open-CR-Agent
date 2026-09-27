import type { Finding, ReviewReport } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { renderJson, renderText } from "./render.js";

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "id",
    fingerprint: "0123456789abcdef",
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
  verdict: "approved",
  summary: "No issues found.",
  coverage: [
    { path: "src/a.ts", status: "reviewed" },
    { path: "yarn.lock", status: "excluded", reason: "generated" },
  ],
  bundles: [],
  skipped: [],
  refuted: [],
  unverifiedCriticals: 0,
  remembered: [],
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
        finding({
          severity: "critical",
          lineRange: { start: 3, end: 5 },
          suggestion: "Guard it.",
          verification: "confirmed",
        }),
        finding({ file: "src/b.ts", lineRange: { start: 7, end: 7 }, verification: "uncertain" }),
        finding({ file: "src/b.ts", title: "File-level" }),
      ],
      warnings: ["grouping failed"],
      verdict: "significant_concerns" as const,
      summary: "Fix the guard first.",
    };
    expect(renderText(report, ".ocra/sessions/s1")).toBe(
      [
        "Review: Working tree changes",
        "Risk tier: lite · 1 reviewed · 0 failed · 1 excluded",
        "Verdict: significant concerns",
        "  Fix the guard first.",
        "",
        "src/a.ts",
        "  critical   L3-5      Title [verified] #01234567",
        "    Body line 1",
        "    Body line 2",
        "    Suggestion: Guard it.",
        "",
        "src/b.ts",
        "  warning    L7        Title [unverified] #01234567",
        "    Body line 1",
        "    Body line 2",
        "  warning    file      File-level [not verified] #01234567",
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
      coverage: [...base.coverage, { path: "src/b.ts", status: "failed" }],
      tasks: [
        ...base.tasks,
        { ...base.tasks[0], taskId: "correctness-2", status: "failed", error: "x" } as never,
      ],
    };
    const text = renderText(report);
    expect(text).toContain("No issues found in the files that were reviewed.");
    expect(text).toContain("Incomplete: 1 of 2 review task(s) did not finish.");
    expect(text).toContain("Incomplete: 1 selected file(s) were not reviewed.");
    expect(renderText(base)).toContain("No issues found.\n");
    const nothingSelected = { ...base, coverage: [base.coverage[1] as never] };
    expect(renderText(nothingSelected)).toContain(
      "Nothing to review: no changed file was selected.",
    );
  });

  it("cannot be steered into terminal escape sequences by finding text", () => {
    const report: ReviewReport = {
      ...base,
      findings: [finding({ title: "ok\u001b[2K\u001b]52;c;eA==\u0007", body: "b\rhidden" })],
    };
    const text = renderText(report);
    for (const unsafe of ["\u001b", "\u0007", "\r"]) expect(text).not.toContain(unsafe);
  });

  it("summarizes the comparison with the previous review", () => {
    const old = {
      fingerprint: "f",
      title: "t",
      file: "a.ts",
      severity: "warning" as const,
      commented: true,
    };
    const report: ReviewReport = {
      ...base,
      rereview: {
        fixed: [old],
        dismissed: [old, old],
        notReproduced: [old],
        notRechecked: [],
        unchanged: [],
      },
    };
    expect(renderText(report)).toContain(
      "Since the last review: 1 fixed, 2 dismissed by reviewers, 1 not reported again but unchanged, 0 not re-checked, 0 in unchanged files (still open ones count in the verdict).",
    );
  });

  it("mentions findings that verification dropped", () => {
    const report: ReviewReport = {
      ...base,
      refuted: [{ fingerprint: "f", file: "a.ts", title: "t", reason: "r" }],
    };
    expect(renderText(report)).toContain(
      "Verification dropped 1 finding(s) the code disproves (see the JSON report).",
    );
  });

  it("never claims a clean result when nothing was reviewed", () => {
    const failed: ReviewReport = {
      ...base,
      coverage: [{ path: "src/a.ts", status: "failed" }],
      tasks: [{ ...base.tasks[0], status: "failed" } as never],
    };
    // The matrix skipped every reviewer: no task ran at all.
    const skipped: ReviewReport = {
      ...base,
      coverage: [{ path: "src/a.ts", status: "unreviewed" }],
    };
    for (const report of [failed, skipped]) {
      expect(renderText(report)).toContain("Verdict: not reached (nothing was reviewed)");
      expect(renderText(report)).toContain("Nothing was reviewed.");
      expect(renderText(report)).not.toContain("No issues found");
      expect(renderText(report)).not.toContain("Verdict: approved");
    }
  });
});

describe("renderJson", () => {
  it("renders the full report", () => {
    expect(JSON.parse(renderJson(base))).toEqual(base);
  });

  it("escapes C1 controls and bidirectional overrides that JSON.stringify leaves raw", () => {
    const hostile = { ...base, summary: "a\u009b2Jb\u202eevil\u2066x" };
    const json = renderJson(hostile);
    for (const c of ["\u009b", "\u202e", "\u2066"]) expect(json).not.toContain(c);
    expect(json).toContain("\\u009b");
    expect(JSON.parse(json)).toEqual(hostile);
  });
});
