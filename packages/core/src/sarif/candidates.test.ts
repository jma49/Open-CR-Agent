import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sarifCandidates } from "./candidates.js";
import { parseSarifLog, SarifError, type SarifRun } from "./schema.js";

const semgrep = parseSarifLog(
  readFileSync(new URL("./__fixtures__/semgrep-1.178.0.sarif", import.meta.url), "utf8"),
);

function run(results: unknown[], rules: unknown[] = [], name = "Tool"): SarifRun {
  return parseSarifLog(
    JSON.stringify({
      version: "2.1.0",
      runs: [{ tool: { driver: { name, rules } }, results }],
    }),
  ).runs[0] as SarifRun;
}

function result(uri: string, extra: Record<string, unknown> = {}, line = 3) {
  return {
    ruleId: "r1",
    message: { text: "m" },
    locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } }],
    ...extra,
  };
}

describe("parseSarifLog", () => {
  it("rejects what is not a SARIF 2.1.0 log", () => {
    expect(() => parseSarifLog("{")).toThrow(SarifError);
    expect(() => parseSarifLog('{"version":"2.0.0","runs":[]}')).toThrow(/not a SARIF 2.1.0/);
    expect(() => parseSarifLog('{"version":"2.1.0"}')).toThrow(SarifError);
  });
});

describe("sarifCandidates", () => {
  it("maps what Semgrep writes: tool, rule, level, lines and snippet", () => {
    const { tool, candidates, skipped } = sarifCandidates(semgrep.runs[0] as SarifRun);
    expect(tool).toEqual({ name: "Semgrep OSS", slug: "semgrep-oss", version: "1.178.0" });
    expect(skipped).toEqual({ noLocation: 0, unsupportedUri: 0, noMessage: 0 });
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      file: "src/app.js",
      lines: { start: 2, end: 2 },
      snippet: "const result = eval(input);",
      severity: "critical",
      ruleId: "js-eval-injection",
      title: "Semgrep Finding: js-eval-injection",
    });
    expect(candidates[0]?.body).toContain(
      "Reported by Semgrep OSS 1.178.0, rule js-eval-injection.",
    );
    expect(candidates[1]).toMatchObject({ severity: "suggestion", ruleId: "js-unused-add" });
  });

  it("takes the severity from the result before the rule, and warning by default", () => {
    const rules = [{ id: "r1", defaultConfiguration: { level: "error" } }];
    const [a, b, c] = sarifCandidates(
      run(
        [result("a.ts", { level: "note" }), result("a.ts"), result("a.ts", { ruleId: "other" })],
        rules,
      ),
    ).candidates;
    expect(a?.severity).toBe("suggestion");
    expect(b?.severity).toBe("critical");
    expect(c?.severity).toBe("warning");
  });

  it("finds the rule by index when the result names none, and titles from the rule", () => {
    const rules = [
      { id: "r0", name: "zero" },
      { id: "r1", shortDescription: { text: "One" } },
    ];
    const { candidates } = sarifCandidates(
      run(
        [
          { ...result("a.ts"), ruleId: undefined, ruleIndex: 1 },
          { ...result("a.ts"), ruleId: undefined, ruleIndex: 0 },
          { ...result("a.ts"), ruleId: undefined },
        ],
        rules,
      ),
    );
    expect(candidates.map((c) => [c.ruleId, c.title])).toEqual([
      ["r1", "One"],
      ["r0", "zero"],
      ["unknown", "unknown"],
    ]);
  });

  it("keeps only repository-relative paths under the source root", () => {
    const { candidates, skipped } = sarifCandidates(
      run([
        result("./src/a.ts"),
        result("src/a%20b.ts"),
        result("src\\win.ts"),
        result("src/a.ts", {
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/a.ts", uriBaseId: "%SRCROOT%" },
                region: { startLine: 1, endLine: 4 },
              },
            },
          ],
        }),
        result("/abs/a.ts"),
        result("file:///abs/a.ts"),
        result("../outside.ts"),
        result("C:/x/a.ts"),
        result("src/a.ts", {
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/a.ts", uriBaseId: "%OTHER%" },
                region: { startLine: 1 },
              },
            },
          ],
        }),
      ]),
    );
    expect(candidates.map((c) => c.file)).toEqual([
      "src/a.ts",
      "src/a b.ts",
      "src/win.ts",
      "src/a.ts",
    ]);
    expect(candidates[3]?.lines).toEqual({ start: 1, end: 4 });
    expect(skipped.unsupportedUri).toBe(5);
  });

  it("counts results without a message or without lines", () => {
    const { candidates, skipped } = sarifCandidates(
      run([
        { ruleId: "r1", message: {}, locations: [] },
        { ruleId: "r1", message: { text: " " } },
        { ruleId: "r1", message: { text: "m" } },
        {
          ruleId: "r1",
          message: { text: "m" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "a.ts" } } }],
        },
      ]),
    );
    expect(candidates).toHaveLength(0);
    expect(skipped).toEqual({ noLocation: 2, unsupportedUri: 0, noMessage: 2 });
  });

  it("slugs the tool name and tolerates a nameless version", () => {
    const { tool } = sarifCandidates(run([], [], "  CodeQL (beta) "));
    expect(tool).toEqual({ name: "  CodeQL (beta) ", slug: "codeql-beta" });
  });
});
