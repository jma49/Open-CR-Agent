import { describe, expect, it } from "vitest";
import type { Finding } from "../domain.js";
import { toReportOutput } from "./output.js";
import { REPORT_VERSION, reportOutputSchema } from "./output-schema.js";
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

  it("copies domain values field by field, so a field the schema lacks stays out", () => {
    const task = {
      taskId: "security-1",
      reviewer: "security",
      bundle: "b",
      files: ["src/a.ts"],
      status: "completed" as const,
      findings: 0,
      durationMs: 1,
      usage: report.usage,
      sessionId: "internal",
    };
    const refuted = { fingerprint: "f", file: "a", title: "t", reason: "r", rawAnswer: "x" };
    const output = toReportOutput({ ...report, runId: "r", tasks: [task], refuted: [refuted] });
    expect(reportOutputSchema.safeParse(output).success).toBe(true);
    expect(JSON.stringify(output)).not.toContain("internal");
    expect(output.refuted[0]).not.toHaveProperty("rawAnswer");
  });
});

// These key lists make a change to the published contract a visible test
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
      provenance: { ocraVersion: "v", promptHash: "p", configHash: "c", sampling: {} },
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
        "provenance",
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
    expect(Object.keys(output.provenance ?? {}).sort()).toEqual(
      ["configHash", "ocraVersion", "promptHash", "sampling"].sort(),
    );
    expect(Object.keys(output.usage).sort()).toEqual(
      ["cachedTokens", "costUsd", "inputTokens", "outputTokens", "reasoningTokens"].sort(),
    );
  });
});
