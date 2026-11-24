import {
  MAX_EVIDENCE,
  MAX_EVIDENCE_FIELD,
  MAX_FIELD,
  MAX_FINDINGS,
  MAX_TOTAL_BYTES,
  REDACTED,
} from "@open-cr-agent/cloud-contract";
import type { Finding } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { sharedFindings } from "./findings.js";

const CODE = "const q = 'SELECT * FROM t WHERE id = ' + id;";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "id",
    fingerprint: "0123456789abcdef",
    reviewer: "security",
    category: "security",
    severity: "critical",
    file: "src/db.ts",
    existingCode: CODE,
    title: "SQL built from input",
    body: "The id reaches the query unescaped.",
    evidence: [],
    provenance: { task: "t1" },
    anchor: { method: "hunk", inDiff: true },
    status: "new",
    lineRange: { start: 10, end: 12 },
    verification: "confirmed",
    ...overrides,
  };
}

describe("sharedFindings", () => {
  it("sends what the web shows, with the line range and the quoted code", () => {
    const { lineRange: _, ...fileLevel } = finding();
    const { findings, left } = sharedFindings({
      findings: [finding({ suggestion: "Use a parameter." }), fileLevel],
    });
    expect(left).toBe(0);
    expect(findings[0]).toEqual({
      fingerprint: "0123456789abcdef",
      reviewer: "security",
      severity: "critical",
      category: "security",
      verification: "confirmed",
      file: "src/db.ts",
      lineStart: 10,
      lineEnd: 12,
      title: "SQL built from input",
      body: "The id reaches the query unescaped.",
      suggestion: "Use a parameter.",
      code: CODE,
    });
    expect(findings[1]).toMatchObject({ lineStart: null, lineEnd: null, suggestion: null });
  });

  it("redacts the title, body, suggestion and code and marks the finding", () => {
    // Built at run time so no secret-shaped literal sits in the repository.
    const secret = `ghp_${"Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z".repeat(2).slice(0, 36)}`;
    const { findings } = sharedFindings({
      findings: [
        finding({
          title: `Token ${secret} committed`,
          body: `Remove ${secret}.`,
          suggestion: `Rotate ${secret}.`,
          existingCode: `const t = "${secret}";`,
        }),
        finding(),
      ],
    });
    expect(JSON.stringify(findings)).not.toContain(secret);
    expect(findings[0]?.redacted).toBe(true);
    expect(findings[0]?.code).toBe(`const t = "${REDACTED}";`);
    expect(findings[1]).not.toHaveProperty("redacted");
  });

  it("sends a fix as written, and leaves out one the redaction pass would change", () => {
    const secret = `ghp_${"Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z".repeat(2).slice(0, 36)}`;
    const fix = { startLine: 10, endLine: 12, replacement: "const q = db.query(sql, [id]);" };
    const { findings } = sharedFindings({
      findings: [
        finding({ fix }),
        finding({ fix: { ...fix, replacement: `const t = "${secret}";` } }),
        finding({ fix: { ...fix, replacement: "x".repeat(MAX_FIELD + 1) } }),
        finding(),
      ],
    });
    expect(findings[0]?.fix).toEqual(fix);
    expect(findings[1]).not.toHaveProperty("fix");
    expect(findings[2]).not.toHaveProperty("fix");
    expect(findings[3]).not.toHaveProperty("fix");
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it("sends the rule a finding applies, and none when it names none", () => {
    const { findings } = sharedFindings({
      findings: [finding({ rule: { kind: "rule", id: "tenant" } }), finding({})],
    });
    expect(findings[0]?.rule).toEqual({ kind: "rule", id: "tenant" });
    expect(findings[1]).not.toHaveProperty("rule");
  });

  it("sends the evidence a comment shows: one line each, redacted, at most five", () => {
    const secret = `ghp_${"Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z".repeat(2).slice(0, 36)}`;
    const { findings } = sharedFindings({
      findings: [
        finding({ evidence: ["`id` comes from\n  `req.params`", "  ", `token ${secret}`] }),
        finding({ evidence: Array.from({ length: MAX_EVIDENCE + 2 }, (_, i) => `fact ${i}`) }),
        finding({ evidence: [`x ${"y".repeat(MAX_EVIDENCE_FIELD)}`] }),
        finding({ evidence: ["", " "] }),
      ],
    });
    expect(findings[0]?.evidence).toEqual(["`id` comes from `req.params`", `token ${REDACTED}`]);
    expect(findings[0]?.redacted).toBe(true);
    expect(findings[0]).not.toHaveProperty("truncated");
    expect(findings[1]?.evidence).toEqual(["fact 0", "fact 1", "fact 2", "fact 3", "fact 4"]);
    expect(findings[1]).not.toHaveProperty("truncated");
    expect(findings[2]?.evidence?.[0]?.length).toBeLessThanOrEqual(MAX_EVIDENCE_FIELD);
    expect(findings[2]?.truncated).toBe(true);
    expect(findings[3]).not.toHaveProperty("evidence");
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it("marks a finding kept with low confidence", () => {
    const { findings } = sharedFindings({
      findings: [finding({ lowConfidence: true }), finding({ lowConfidence: false })],
    });
    expect(findings[0]?.lowConfidence).toBe(true);
    expect(findings[1]).not.toHaveProperty("lowConfidence");
  });

  it("cuts a long field and marks the finding truncated", () => {
    const { findings } = sharedFindings({
      findings: [finding({ body: "x".repeat(MAX_FIELD + 10) }), finding()],
    });
    expect(findings[0]?.body).toHaveLength(MAX_FIELD);
    expect(findings[0]?.truncated).toBe(true);
    expect(findings[1]).not.toHaveProperty("truncated");
    // Never half of a surrogate pair at the cut.
    const emoji = sharedFindings({
      findings: [finding({ body: `${"x".repeat(MAX_FIELD - 1)}😀` })],
    }).findings[0];
    expect(emoji?.body).toBe("x".repeat(MAX_FIELD - 1));
  });

  it("cuts a field before redacting it, so what lies past the cap is never read", () => {
    const secret = `ghp_${"Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z".repeat(2).slice(0, 36)}`;
    const [shared] = sharedFindings({
      findings: [finding({ existingCode: `${"x ".repeat(MAX_FIELD)}${secret}` })],
    }).findings;
    expect(shared?.code).toHaveLength(MAX_FIELD);
    expect(shared?.truncated).toBe(true);
    // Nothing sent was replaced, so the finding is not marked redacted.
    expect(shared).not.toHaveProperty("redacted");
  });

  it("sends at most 200 findings and 256 KB of text, and counts what it left", () => {
    const many = Array.from({ length: MAX_FINDINGS + 5 }, () => finding());
    expect(sharedFindings({ findings: many })).toMatchObject({ left: 5 });
    expect(sharedFindings({ findings: many }).findings).toHaveLength(MAX_FINDINGS);

    const big = Array.from({ length: 40 }, () =>
      finding({ body: "b".repeat(MAX_FIELD), existingCode: "c".repeat(MAX_FIELD) }),
    );
    const { findings, left } = sharedFindings({ findings: big });
    const bytes = findings.reduce(
      (sum, f) =>
        sum +
        [f.title, f.body, f.suggestion ?? "", f.code].reduce(
          (s, t) => s + Buffer.byteLength(JSON.stringify(t)),
          0,
        ),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    expect(findings.length).toBeGreaterThan(0);
    expect(left).toBe(40 - findings.length);
    expect(left).toBeGreaterThan(0);
  });
});
