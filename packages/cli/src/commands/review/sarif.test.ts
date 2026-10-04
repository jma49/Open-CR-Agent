import { type Finding, parseSarifLog, type ReviewReport } from "@open-cr-agent/core";
import { at, serializeOutput } from "@open-cr-agent/core/internal";
import { describe, expect, it } from "vitest";
import { plainText, renderSarif, sarifLog } from "./sarif.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "id",
    fingerprint: "0123456789abcdef",
    reviewer: "correctness",
    category: "correctness",
    severity: "warning",
    file: "src/a.ts",
    existingCode: "x",
    lineRange: { start: 3, end: 5 },
    title: "Off by one",
    body: "The loop stops early.",
    evidence: [],
    provenance: { task: "t1" },
    anchor: { method: "hunk", inDiff: true },
    verification: "confirmed",
    status: "new",
    ...overrides,
  };
}

const report: ReviewReport = {
  runId: "20261002T070000Z-abcdef",
  changeRequest: { id: "1", title: "t", description: "", baseSha: "b", headSha: "h" },
  tier: "full",
  verdict: "approved_with_comments",
  summary: "s",
  coverage: [{ path: "src/a.ts", status: "reviewed" }],
  bundles: [],
  tasks: [],
  skipped: [],
  findings: [],
  unverifiedCriticals: 0,
  refuted: [],
  remembered: [],
  usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, costUsd: 0.5 },
  warnings: [],
};

// The log as written, typed; the first test also reads it back through
// core's SARIF schema, as --import-sarif would.
const sarif = (r: ReviewReport) => sarifLog(r, "1.2.3");
const firstRun = (r: ReviewReport) => at(sarif(r).runs, 0);

describe("renderSarif", () => {
  it("writes a SARIF 2.1.0 log with one rule per reviewer category", () => {
    const log = sarif({
      ...report,
      findings: [
        finding(),
        finding({ category: "security", reviewer: "security", severity: "critical" }),
        finding({ fingerprint: "fedcba9876543210", severity: "suggestion" }),
      ],
    });
    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toBe("https://json.schemastore.org/sarif-2.1.0.json");
    expect(parseSarifLog(serializeOutput(log)).runs).toHaveLength(1);
    const run = at(log.runs, 0);
    expect(run.tool.driver).toMatchObject({ name: "ocra", version: "1.2.3" });
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual(["correctness", "security"]);
    expect(run.results.map((r) => [r.ruleId, r.ruleIndex, r.level])).toEqual([
      ["correctness", 0, "warning"],
      ["security", 1, "error"],
      ["correctness", 0, "note"],
    ]);
    expect(at(run.invocations, 0).executionSuccessful).toBe(true);
    expect(run.properties).toMatchObject({ verdict: "approved_with_comments", tier: "full" });
  });

  it("carries a finding's text, lines, fingerprint and verification", () => {
    const result = at(
      firstRun({ ...report, findings: [finding({ suggestion: "Use <=." })] }).results,
      0,
    );
    expect(result.message.text).toBe("Off by one\n\nThe loop stops early.\n\nSuggestion: Use <=.");
    expect(at(result.locations, 0).physicalLocation).toEqual({
      artifactLocation: { uri: "src/a.ts", uriBaseId: "%SRCROOT%" },
      region: { startLine: 3, endLine: 5 },
    });
    expect(result.partialFingerprints).toEqual({ "ocra/v1": "0123456789abcdef" });
    expect(result.properties).toEqual({
      reviewer: "correctness",
      severity: "warning",
      verification: "confirmed",
      status: "new",
      task: "t1",
    });
  });

  it("gives a finding without lines the whole file, and encodes the path as a URI", () => {
    const { lineRange: _, ...noLines } = finding({ file: "docs/a b#c?.md" });
    const run = firstRun({ ...report, findings: [noLines] });
    expect(at(at(run.results, 0).locations, 0).physicalLocation).toEqual({
      artifactLocation: { uri: "docs/a%20b%23c%3F.md", uriBaseId: "%SRCROOT%" },
    });
  });

  it("carries a finding's fix as a replacement of its whole lines, code as written", () => {
    const replacement = 'for (let i = 0; i <= n; i++) {\n  visit("[x](y) {0}");';
    const log = sarif({
      ...report,
      findings: [
        finding({ fix: { startLine: 3, endLine: 5, replacement } }),
        finding({
          fingerprint: "1".repeat(16),
          fix: { startLine: 7, endLine: 8, replacement: "" },
        }),
        finding({ fingerprint: "2".repeat(16) }),
      ],
    });
    const [withFix, deletion, without] = at(log.runs, 0).results;
    expect(withFix?.fixes).toEqual([
      {
        description: { text: "Replace the lines with the suggested code" },
        artifactChanges: [
          {
            artifactLocation: { uri: "src/a.ts", uriBaseId: "%SRCROOT%" },
            replacements: [
              {
                deletedRegion: { startLine: 3, endLine: 5 },
                insertedContent: { text: replacement },
              },
            ],
          },
        ],
      },
    ]);
    expect(deletion?.fixes?.[0]?.artifactChanges[0]?.replacements).toEqual([
      {
        deletedRegion: { startLine: 7, startColumn: 1, endLine: 9, endColumn: 1 },
        insertedContent: { text: "" },
      },
    ]);
    expect(without).toBeDefined();
    expect(without?.fixes).toBeUndefined();
  });

  it("keeps findings still open from an earlier review, marked unchanged", () => {
    const open = {
      fingerprint: "aaaaaaaaaaaaaaaa",
      title: "Leaked handle",
      file: "src/old.ts",
      severity: "critical" as const,
      commented: true,
    };
    const run = firstRun({
      ...report,
      rereview: {
        fixed: [],
        notReproduced: [],
        notRechecked: [],
        unchanged: [open],
        dismissed: [],
      },
    });
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual(["ocra-carried-over"]);
    expect(run.results).toEqual([
      expect.objectContaining({
        ruleId: "ocra-carried-over",
        level: "error",
        baselineState: "unchanged",
        message: { text: "Leaked handle" },
        partialFingerprints: { "ocra/v1": "aaaaaaaaaaaaaaaa" },
      }),
    ]);
  });

  it("reports an incomplete review as an unsuccessful run, with its warnings", () => {
    const run = firstRun({
      ...report,
      coverage: [...report.coverage, { path: "src/b.ts", status: "unreviewed" }],
      warnings: ["spend limit of $2 reached"],
    });
    const invocation = at(run.invocations, 0);
    expect(invocation.executionSuccessful).toBe(false);
    expect(invocation.toolExecutionNotifications.map((n) => n.message.text)).toEqual([
      "1 selected file(s) were not reviewed",
      "spend limit of $2 reached",
    ]);
    expect(run.properties.notReviewed).toEqual(["src/b.ts"]);
  });

  it("escapes control characters a terminal or editor would act on", () => {
    const out = renderSarif({ ...report, findings: [finding({ title: "a\u202eb\u009bc" })] }, "1");
    expect(out).toContain("a\\u202eb\\u009bc");
    expect(out).not.toContain("\u202e");
  });
});

// Every bracket in the text must be escaped, counting the backslashes before
// it: an even number means the bracket itself is not.
function unescapedBrackets(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "[" && text[i] !== "]") continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j -= 1) slashes += 1;
    if (slashes % 2 === 0) count += 1;
  }
  return count;
}

describe("plainText", () => {
  it.each([
    "[click here](https://evil.example)",
    "\\[click\\](https://evil.example)",
    "[a\\](1) and \\\\[b](2)",
    "see [the docs][1]",
  ])("leaves no embedded link in %j", (text) => {
    const safe = plainText(text);
    expect(unescapedBrackets(safe)).toBe(0);
    expect(safe).not.toMatch(/https?:\/\//);
  });

  it("keeps web addresses readable but not linkable", () => {
    expect(plainText("go to https://x.example or www.y.example")).toBe(
      "go to https\u200b://x.example or www\u200b.y.example",
    );
  });

  it("doubles braces, which SARIF reserves for placeholders", () => {
    // Code scanning showed "{{0}}" as "{0}" (an upload on 2026-09-30).
    expect(plainText("format({0}) with {name} }")).toBe("format({{0}}) with {{name}} }}");
  });

  it("keeps other text as it is", () => {
    expect(plainText("Use a <= b; a@b.c; `code`")).toBe("Use a <= b; a@b.c; `code`");
  });
});
