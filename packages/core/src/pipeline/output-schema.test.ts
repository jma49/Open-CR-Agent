import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Finding } from "../domain.js";
import { toReportOutput } from "./output.js";
import { REPORT_SCHEMA_ID, reportJsonSchema, reportOutputSchema } from "./output-schema.js";
import type { ReviewReport } from "./report.js";

const usage = {
  inputTokens: 3,
  outputTokens: 2,
  reasoningTokens: 1,
  cachedTokens: 0,
  costUsd: 0.01,
};

const finding: Finding = {
  id: "per-run",
  fingerprint: "0123456789abcdef",
  reviewer: "security",
  category: "security",
  severity: "critical",
  file: "src/a.ts",
  existingCode: "eval(input)",
  title: "Eval of user input",
  body: "Remote code execution.",
  suggestion: "Parse it.",
  evidence: ["the query string"],
  lineRange: { start: 3, end: 3 },
  provenance: { task: "security-1", model: "p/m" },
  anchor: { method: "hunk", inDiff: true },
  status: "unfixed",
  verification: "confirmed",
  lowConfidence: true,
  quote: { lines: 1, hash: "fedcba9876543210" },
};

const prior = {
  fingerprint: "1".repeat(16),
  title: "t",
  file: "src/b.ts",
  severity: "warning" as const,
  verification: "uncertain" as const,
  commented: true,
};

// Every optional field set, so the strict schema sees the whole output.
const full: ReviewReport = {
  runId: "20261002T070000Z-abcdef",
  changeRequest: {
    id: "1",
    title: "t",
    description: "",
    baseSha: "b",
    headSha: "h",
    override: { by: "m", reason: "r" },
  },
  tier: "full",
  verdict: "significant_concerns",
  summary: "s",
  scope: { mode: "incremental", since: "abc" },
  coverage: [
    { path: "src/a.ts", status: "reviewed" },
    { path: "src/b.ts", status: "unchanged" },
    { path: "yarn.lock", status: "excluded", reason: "generated" },
  ],
  bundles: [{ label: "b", files: ["src/a.ts"] }],
  tasks: [
    {
      taskId: "security-1",
      reviewer: "security",
      bundle: "b",
      files: ["src/a.ts"],
      status: "failed",
      error: "boom",
      findings: 1,
      durationMs: 5,
      usage,
    },
  ],
  skipped: [{ reviewer: "docs", bundle: "b", reason: "no_matching_files" }],
  findings: [finding, { ...finding, fingerprint: "2".repeat(16), provenance: { task: "x" } }],
  unverifiedCriticals: 1,
  refuted: [{ fingerprint: "3".repeat(16), file: "src/a.ts", title: "t", reason: "r" }],
  remembered: [{ fingerprint: "4".repeat(16), file: "src/a.ts", title: "t", reason: "r" }],
  judgement: {
    merged: [{ kept: "a", merged: ["b"] }],
    dropped: [{ fingerprint: "5".repeat(16), file: "f", title: "t", reason: "r" }],
    recalibrated: [{ fingerprint: "6".repeat(16), from: "critical", to: "warning", reason: "r" }],
  },
  rereview: {
    fixed: [prior],
    notReproduced: [prior],
    notRechecked: [prior],
    unchanged: [prior],
    dismissed: [prior],
  },
  anchoring: {
    byMethod: { hunk: 1, file: 0, cross_file: 0, relocated: 0, file_level: 1 },
    ambiguous: 1,
    relocationCalls: 2,
  },
  spendLimit: { usd: 2, reached: "total" },
  usage,
  warnings: ["w"],
};

describe("reportOutputSchema", () => {
  it("accepts everything toReportOutput writes, and nothing else", () => {
    const output = JSON.parse(JSON.stringify(toReportOutput(full)));
    expect(reportOutputSchema.parse(output)).toEqual(output);
    expect(reportOutputSchema.safeParse({ ...output, extra: 1 }).success).toBe(false);
    expect(
      reportOutputSchema.safeParse({
        ...output,
        findings: [{ ...output.findings[0], anchor: {} }],
      }).success,
    ).toBe(false);
  });

  it("rejects another version", () => {
    const output = toReportOutput(full);
    expect(reportOutputSchema.safeParse({ ...output, version: 2 }).success).toBe(false);
  });
});

describe("reportJsonSchema", () => {
  it("is what docs/schema/report.v1.json holds (npm run schema regenerates it)", () => {
    const published = JSON.parse(
      readFileSync(new URL("../../../../docs/schema/report.v1.json", import.meta.url), "utf8"),
    );
    expect(published).toEqual(reportJsonSchema());
  });

  it("is a draft 2020-12 schema with an id, and nothing in it is open", () => {
    const schema = reportJsonSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe(REPORT_SCHEMA_ID);
    const text = JSON.stringify(schema);
    expect(text).not.toContain('"additionalProperties":true');
    expect(text).toContain('"provenance"');
  });
});
