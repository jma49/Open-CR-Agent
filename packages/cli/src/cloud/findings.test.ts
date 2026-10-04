import type { Finding } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import {
  MAX_FIELD,
  MAX_FINDINGS,
  MAX_TOTAL_BYTES,
  REDACTED,
  redact,
  sharedFindings,
} from "./findings.js";
import vectors from "./redaction-vectors.json" with { type: "json" };

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

// Built at run time so no secret-shaped literal sits in the repository.
const tail = (n: number, alphabet = "Ab3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z") =>
  alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n);
const SECRETS: Record<string, string> = {
  pem: `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${tail(40)}\n-----END RSA PRIVATE KEY-----`,
  aws: `AKIA${"ABCDEFGHIJKLMNOP"}`,
  awsSession: `ASIA${"QRSTUVWXYZ234567"}`,
  ghp: `ghp_${tail(36)}`,
  gho: `gho_${tail(36)}`,
  ghs: `ghs_${tail(36)}`,
  ghu: `ghu_${tail(36)}`,
  ghr: `ghr_${tail(36)}`,
  githubPat: `github_pat_${tail(30)}_${tail(20)}`,
  gitlab: `glpat-${tail(20)}`,
  openai: `sk-${tail(40)}`,
  anthropic: `sk-ant-${tail(40)}`,
  openrouter: `sk-or-${tail(40)}`,
  project: `sk-proj-${tail(40)}`,
  slack: `xoxb-${"1234567890"}-${tail(12)}`,
  google: `AIza${tail(35)}`,
  npm: `npm_${tail(36)}`,
  longMixed: tail(40),
};

describe("redact", () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    it(`replaces a ${name} token`, () => {
      const r = redact(`const key = "${secret}"; // used below`);
      expect(r.redacted).toBe(true);
      expect(r.text).toContain(REDACTED);
      expect(r.text).not.toContain(secret);
      expect(r.text).toContain("// used below");
    });
  }

  it("leaves ordinary code, paths and identifiers alone", () => {
    const code = [
      "export async function fetchAccountMemoryForRepository(repoHash: string) {}",
      "import { x } from '../../packages/core/src/pipeline/output-schema.ts';",
      "const SOME_VERY_LONG_CONSTANT_NAME_WITHOUT_DIGITS = 1;",
      "const task = 'sk-short';",
      "// https://github.com/jma49/open-cr-agent/blob/main/docs/adr/0028-findings.md",
    ].join("\n");
    expect(redact(code)).toEqual({ text: code, redacted: false });
  });
});

describe("the vectors shared with ocra Cloud", () => {
  // ocra Cloud's server pass runs the same file (test/redaction-vectors.json there).
  it("redacts every secret line and keeps every plain one", () => {
    for (const v of vectors.redact) {
      const r = redact(v.line);
      expect(r.redacted, v.line).toBe(true);
      expect(r.text, v.line).not.toContain(v.secret);
    }
    for (const line of vectors.keep)
      expect(redact(line), line).toEqual({ text: line, redacted: false });
  });

  it("redacts a hex run of 32 or more, which may be a key as well as a digest", () => {
    const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(redact(`const sha = '${sha}';`).text).toBe(`const sha = '${REDACTED}';`);
  });
});

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
    const secret = SECRETS.ghp as string;
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
