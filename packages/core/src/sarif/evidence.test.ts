import { describe, expect, it } from "vitest";
import { at } from "../at.js";
import type { Bundle } from "../bundle/bundle.js";
import { parseUnifiedDiff } from "../diff/parse.js";
import type { FileDiff } from "../domain.js";
import {
  analyzerEvidence,
  EVIDENCE_MARGIN_LINES,
  evidenceUses,
  MAX_EVIDENCE_MESSAGE_CHARS,
  MAX_EVIDENCE_PER_BUNDLE,
} from "./evidence.js";
import { parseSarifLog, type SarifLog } from "./schema.js";

// Hunks cover new-side lines 20-24 of each file.
function changed(path: string) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -20,4 +20,5 @@",
    " a",
    " b",
    "+c",
    " d",
    " e",
  ].join("\n");
}

const diffs = parseUnifiedDiff([changed("src/a.ts"), changed("src/b.ts")].join("\n"));
const a = at(diffs, 0);
const b = at(diffs, 1);
const bundle = (label: string, ...files: FileDiff[]): Bundle => ({ label, files });

interface Result {
  file?: string;
  line?: number;
  rule?: string;
  level?: string;
  text?: string;
  tags?: string[];
}

function log(results: Result[], name = "Semgrep OSS"): SarifLog {
  return parseSarifLog(
    JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name, semanticVersion: "1.178.0" } },
          results: results.map((r) => ({
            ruleId: r.rule ?? "r1",
            level: r.level ?? "warning",
            message: { text: r.text ?? "m" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: r.file ?? "src/a.ts" },
                  region: { startLine: r.line ?? 22 },
                },
              },
            ],
            ...(r.tags ? { properties: { tags: r.tags } } : {}),
          })),
        },
      ],
    }),
  );
}

describe("analyzerEvidence", () => {
  it("keeps results on and near the change, and counts the rest", () => {
    const evidence = analyzerEvidence(
      [
        log([
          { line: 22, rule: "on" },
          { line: 24 + EVIDENCE_MARGIN_LINES, rule: "near" },
          { line: 25 + EVIDENCE_MARGIN_LINES, rule: "away" },
          { file: "src/other.ts", rule: "elsewhere" },
        ]),
      ],
      [bundle("a", a)],
    );
    const results = evidence.forBundle(bundle("a", a));
    expect(results.map((r) => [r.ruleId, r.onChange])).toEqual([
      ["on", true],
      ["near", false],
    ]);
    expect(results[0]).toMatchObject({
      tool: { name: "Semgrep OSS", version: "1.178.0" },
      file: "src/a.ts",
      lines: { start: 22, end: 22 },
      severity: "warning",
    });
    expect(evidence.warnings).toEqual([
      "Semgrep OSS: gave reviewers 2 result(s) as evidence; left out 2 away from the change",
    ]);
  });

  it("ranks the change first, then severity, then security", () => {
    const evidence = analyzerEvidence(
      [
        log([
          { line: 15, rule: "near-error", level: "error" },
          { line: 21, rule: "note", level: "note" },
          { line: 21, rule: "warning" },
          { line: 23, rule: "security-warning", tags: ["CWE-89", "Security"] },
          { line: 22, rule: "error", level: "error" },
        ]),
      ],
      [bundle("a", a)],
    );
    expect(evidence.forBundle(bundle("a", a)).map((r) => r.ruleId)).toEqual([
      "error",
      "security-warning",
      "warning",
      "note",
      "near-error",
    ]);
  });

  it("caps each bundle, gives a task only its own files, and reports what was given", () => {
    const many = Array.from({ length: MAX_EVIDENCE_PER_BUNDLE + 3 }, (_, i) => ({
      rule: `r${String(i).padStart(2, "0")}`,
    }));
    const both = bundle("both", a, b);
    const evidence = analyzerEvidence(
      [log([...many, { file: "src/b.ts", rule: "on-b", level: "error" }])],
      [both],
    );
    const all = evidence.forBundle(both);
    expect(all).toHaveLength(MAX_EVIDENCE_PER_BUNDLE);
    expect(all[0]?.ruleId).toBe("on-b");
    expect(evidence.forBundle(bundle("both", b)).map((r) => r.ruleId)).toEqual(["on-b"]);
    expect(evidence.warnings).toEqual([
      `Semgrep OSS: gave reviewers ${MAX_EVIDENCE_PER_BUNDLE} result(s) as evidence; left out 4 over the limit of ${MAX_EVIDENCE_PER_BUNDLE} per bundle`,
    ]);
    expect(evidenceUses(evidence, [both])).toEqual([
      {
        tool: "Semgrep OSS",
        version: "1.178.0",
        results: MAX_EVIDENCE_PER_BUNDLE,
        bundles: ["both"],
      },
    ]);
  });

  it("drops a result two logs repeat, and bounds the message", () => {
    const long = "x".repeat(MAX_EVIDENCE_MESSAGE_CHARS + 50);
    const evidence = analyzerEvidence(
      [log([{ text: long }]), log([{ text: long }])],
      [bundle("a", a)],
    );
    const results = evidence.forBundle(bundle("a", a));
    expect(results).toHaveLength(1);
    expect(results[0]?.message).toHaveLength(MAX_EVIDENCE_MESSAGE_CHARS);
  });

  it("gives nothing without logs", () => {
    const evidence = analyzerEvidence([], [bundle("a", a)]);
    expect(evidence.forBundle(bundle("a", a))).toEqual([]);
    expect(evidenceUses(evidence, [bundle("a", a)])).toEqual([]);
  });
});
