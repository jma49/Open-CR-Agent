import { describe, expect, it } from "vitest";
import type { Finding } from "../domain.js";
import { selectInline } from "./inline.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f",
    fingerprint: "f",
    reviewer: "correctness",
    category: "bug",
    severity: "warning",
    file: "src/a.ts",
    existingCode: "a()",
    title: "A finding",
    body: "What is wrong.",
    evidence: [],
    provenance: { task: "correctness-1" },
    anchor: { method: "hunk", inDiff: true },
    status: "new",
    ...overrides,
  };
}

const at = (fingerprint: string, overrides: Partial<Finding> = {}): Finding =>
  finding({ fingerprint, lineRange: { start: 10, end: 10 }, ...overrides });

describe("selectInline", () => {
  it("holds nothing back without a floor or a cap", () => {
    expect(selectInline([at("a")], {})).toBeUndefined();
  });

  it("holds back what is below the floor, and keeps it out of the cap", () => {
    const findings = [
      at("a", { severity: "suggestion" }),
      at("b", { severity: "warning" }),
      at("c", { severity: "critical" }),
    ];
    expect(selectInline(findings, { minSeverity: "warning", maxComments: 2 })).toEqual({
      minSeverity: "warning",
      maxComments: 2,
      held: [{ fingerprint: "a", reason: "below_floor" }],
    });
  });

  it("keeps the most severe, then the confirmed, then the confident, then by place", () => {
    const findings = [
      at("low", { severity: "critical", verification: "confirmed", lowConfidence: true }),
      at("unchecked", { severity: "critical" }),
      at("later", {
        severity: "critical",
        verification: "confirmed",
        lineRange: { start: 20, end: 20 },
      }),
      at("warning", { severity: "warning", verification: "confirmed" }),
      at("first", { severity: "critical", verification: "confirmed" }),
      at("uncertain", { severity: "critical", verification: "uncertain" }),
    ];
    const held = selectInline(findings, { maxComments: 2 })?.held;
    expect(held).toEqual([
      { fingerprint: "low", reason: "over_cap" },
      { fingerprint: "uncertain", reason: "over_cap" },
      { fingerprint: "unchecked", reason: "over_cap" },
      { fingerprint: "warning", reason: "over_cap" },
    ]);
  });

  it("chooses the same findings whatever order they arrive in", () => {
    const findings = [
      at("b", { file: "src/b.ts" }),
      at("a2", { file: "src/a.ts" }),
      at("a1", { file: "src/a.ts" }),
    ];
    const one = selectInline(findings, { maxComments: 1 });
    const other = selectInline([...findings].reverse(), { maxComments: 1 });
    expect(one).toEqual(other);
    expect(one?.held.map((h) => h.fingerprint)).toEqual(["a2", "b"]);
  });

  it("leaves out findings a platform cannot comment on inline", () => {
    const findings = [
      at("outside", { anchor: { method: "file", inDiff: false } }),
      finding({ fingerprint: "file-level" }),
      at("kept"),
    ];
    expect(selectInline(findings, { maxComments: 0 })?.held).toEqual([
      { fingerprint: "kept", reason: "over_cap" },
    ]);
  });
});
