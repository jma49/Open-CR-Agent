import { describe, expect, it } from "vitest";
import type { Finding } from "../domain.js";
import { REPORT_VERSION, toPlanOutput, toReportOutput } from "./output.js";
import type { ReviewPreview } from "./preview.js";
import type { ReviewReport } from "./report.js";

const finding: Finding = {
  id: "b2c8e5f0-random-per-run",
  fingerprint: "0123456789abcdef",
  reviewer: "security",
  category: "security",
  severity: "critical",
  file: "src/a.ts",
  existingCode: "eval(input)",
  title: "Eval of user input",
  body: "Remote code execution.",
  evidence: ["input comes from the query string"],
  lineRange: { start: 3, end: 3 },
  provenance: { task: "security-1", model: "google/gemini-3.5-flash" },
  anchor: { method: "hunk", inDiff: true },
  status: "new",
  quote: { lines: 1, hash: "fedcba9876543210" },
};

const report = {
  changeRequest: { id: "1", title: "t", description: "", baseSha: "b", headSha: "h" },
  tier: "full",
  verdict: "minor_issues",
  summary: "s",
  coverage: [],
  bundles: [],
  tasks: [],
  skipped: [],
  findings: [finding, { ...finding, fingerprint: "1".repeat(16), lineRange: undefined }],
  unverifiedCriticals: 1,
  refuted: [],
  remembered: [],
  usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 },
  warnings: [],
} as unknown as ReviewReport;

describe("toReportOutput", () => {
  it("publishes a versioned report without internal fields", () => {
    const output = toReportOutput(report);
    expect(output.version).toBe(REPORT_VERSION);
    expect(output.findings[0]).toEqual({
      fingerprint: "0123456789abcdef",
      reviewer: "security",
      category: "security",
      severity: "critical",
      verification: "unchecked",
      file: "src/a.ts",
      lines: { start: 3, end: 3 },
      inDiff: true,
      status: "new",
      title: "Eval of user input",
      body: "Remote code execution.",
      evidence: ["input comes from the query string"],
      code: "eval(input)",
      provenance: { task: "security-1", model: "google/gemini-3.5-flash" },
    });
    expect(output.findings[1]?.lines).toBeUndefined();
    const json = JSON.stringify(output);
    for (const internal of ["b2c8e5f0", "anchor", "quote", "lineRange", "existingCode"]) {
      expect(json).not.toContain(internal);
    }
  });
});

// The versioned outputs embed some domain types; a change to one of them
// changes a published contract. These key lists make that a visible test
// change: add optional fields freely, anything else needs a new version.
describe("output contract", () => {
  it("pins the report's top-level and nested keys", () => {
    const full = {
      ...report,
      scope: { mode: "full", reason: "r" },
      judgement: { merged: [], dropped: [], recalibrated: [] },
      rereview: { fixed: [], notReproduced: [], notRechecked: [], unchanged: [], dismissed: [] },
      changeRequest: { ...report.changeRequest, override: { by: "m", reason: "r" } },
      anchoring: {
        byMethod: { hunk: 1, file: 0, cross_file: 0, relocated: 0, file_level: 1 },
        ambiguous: 1,
        relocationCalls: 0,
      },
      spendLimit: { usd: 2, reached: "review" },
    } as ReviewReport;
    const output = toReportOutput(full);
    expect(Object.keys(output).sort()).toEqual(
      [
        "anchoring",
        "bundles",
        "changeRequest",
        "coverage",
        "findings",
        "judgement",
        "refuted",
        "remembered",
        "rereview",
        "runId",
        "scope",
        "skipped",
        "spendLimit",
        "summary",
        "tasks",
        "tier",
        "unverifiedCriticals",
        "usage",
        "verdict",
        "version",
        "warnings",
      ].sort(),
    );
    expect(Object.keys(output.changeRequest).sort()).toEqual(
      ["baseSha", "description", "headSha", "id", "override", "title"].sort(),
    );
    expect(Object.keys(output.anchoring ?? {}).sort()).toEqual(
      ["ambiguous", "byMethod", "relocationCalls"].sort(),
    );
    expect(output.spendLimit).toEqual({ usd: 2, reached: "review" });
    expect(Object.keys(output.usage).sort()).toEqual(
      ["cachedTokens", "costUsd", "inputTokens", "outputTokens", "reasoningTokens"].sort(),
    );
  });

  it("pins the plan's keys", () => {
    const preview = {
      changeRequest: report.changeRequest,
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
