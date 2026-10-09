import { describe, expect, it } from "vitest";
import vectors from "../fixtures/redaction-vectors.json" with { type: "json" };
import { MAX_FIELD } from "./limits.js";
import { REDACTED, redact, redactField } from "./redact.js";

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
  digitalocean: `dop_v1_${"0123456789abcdef".repeat(4)}`,
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

// The fastest of up to three runs, so a pause of the test machine does not
// read as a slow pattern; one that rescans its input is slow every time.
function fastest(budgetMs: number, run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3 && best >= budgetMs; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe("what redact costs", () => {
  // Runs crafted so a pattern that can rescan a run from each position of it
  // takes seconds at this size.
  const SIZE = 100_000;
  const UNITS = [
    "a.",
    "a-",
    "a",
    "eyJ-",
    "x://a:",
    "://a:b",
    "a-u a:",
    " -u a:",
    "password=",
    "password: a",
    "token = 'a",
    "password=_",
    "pwd:a",
    "<pwd://",
    "Bearer a-",
    "sk-a-",
    "0a_",
    "-----BEGIN A PRIVATE KEY-----",
  ];

  it("is linear in its input: 100k characters of any crafted run take under 200 ms", {
    timeout: 300_000,
  }, () => {
    for (const unit of UNITS) {
      const text = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
      expect(
        fastest(200, () => redact(text)),
        unit,
      ).toBeLessThan(200);
    }
  });
});

describe("redact run twice", () => {
  it("finds nothing more the second time, so ocra Cloud's pass leaves the CLI's alone", () => {
    for (const v of vectors.redact)
      expect(redact(redact(v.line).text).redacted, v.line).toBe(false);
  });
});

describe("redactField", () => {
  const secret = SECRETS.ghp ?? "";

  it("redacts a field within the cap and leaves it whole", () => {
    expect(redactField(`const t = "${secret}";`)).toEqual({
      text: `const t = "${REDACTED}";`,
      redacted: true,
      truncated: false,
    });
    expect(redactField("plain")).toEqual({ text: "plain", redacted: false, truncated: false });
  });

  it("cuts a longer field at MAX_FIELD before redacting it, and says so", () => {
    const r = redactField(`${"x ".repeat(MAX_FIELD)}${secret}`);
    expect(r).toMatchObject({ redacted: false, truncated: true });
    expect(r.text).toHaveLength(MAX_FIELD);
  });

  it("reads the token the cut falls in whole, so no part of it is sent", () => {
    for (const offset of [1, 10, secret.length - 1]) {
      const r = redactField(`${"x ".repeat(50)}${secret} tail`, 100 + offset);
      expect(r.truncated, String(offset)).toBe(true);
      expect(r.text, String(offset)).not.toContain(secret.slice(0, offset));
    }
    const quoted = redactField(`${"x ".repeat(50)}password = "correct horse battery staple"`, 130);
    expect(quoted.text).not.toMatch(/correct|horse/);
  });

  it("stays within the cap when redacting lengthens the text", () => {
    const r = redactField("redis://:pw@h ".repeat(7), 100);
    expect(r.text.length).toBeLessThanOrEqual(100);
    expect(r).toMatchObject({ redacted: true, truncated: true });
  });

  it("never leaves half of a surrogate pair at the cut", () => {
    expect(redactField(`${"x".repeat(9)}😀`, 10).text).toBe("x".repeat(9));
  });

  it("costs what the cap allows, however long the field", () => {
    const text = "a.".repeat(5_000_000);
    expect(fastest(50, () => redactField(text))).toBeLessThan(50);
  });
});
