import { describe, expect, it } from "vitest";
import vectors from "../fixtures/redaction-vectors.json" with { type: "json" };
import { REDACTED, redact } from "./redact.js";

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

describe("the vectors ocra Cloud runs too", () => {
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
