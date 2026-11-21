import { describe, expect, it } from "vitest";
import {
  candidateCase,
  claimsFrom,
  isFixSubject,
  isMinedPath,
  isTrivialLine,
  parseBlame,
  rewrittenRanges,
} from "./fix-mining.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const F = "f".repeat(40);
const fix = { sha: F, subject: "fix(core): handle an empty bundle" };

describe("isFixSubject", () => {
  it("takes fixes and reverts, not other work that mentions them", () => {
    expect(isFixSubject("fix(cli): wait for the lock")).toBe(true);
    expect(isFixSubject("fix!: drop the old flag")).toBe(true);
    expect(isFixSubject('Revert "feat: add x"')).toBe(true);
    expect(isFixSubject("Fixes a crash on empty input")).toBe(true);
    expect(isFixSubject("feat(core): add a prefix filter")).toBe(false);
    expect(isFixSubject("docs: explain the fixture layout")).toBe(false);
  });
});

describe("isMinedPath", () => {
  it("keeps source and leaves out docs, tests and data", () => {
    expect(isMinedPath("packages/core/src/run.ts")).toBe(true);
    expect(isMinedPath("scripts/lib/gate.mjs")).toBe(true);
    for (const path of [
      "README.md",
      "docs/manual/en/x.mdx",
      "packages/core/src/run.test.ts",
      "packages/core/src/run.e2e.test.ts",
      "package-lock.json",
      "src/__snapshots__/a.ts.snap",
      "tests/helpers.py",
      ".changeset/x.md",
      "CHANGELOG.md",
    ]) {
      expect(isMinedPath(path), path).toBe(false);
    }
  });
});

describe("rewrittenRanges", () => {
  it("reads the pre-image of rewrites and removals, not pure additions", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "@@ -3 +3 @@ function a() {",
      "@@ -10,2 +10 @@",
      "@@ -20,0 +21,4 @@",
    ].join("\n");
    expect(rewrittenRanges(diff)).toEqual([
      { start: 3, count: 1 },
      { start: 10, count: 2 },
    ]);
  });
});

describe("parseBlame", () => {
  it("pairs each line with the commit and line number that introduced it", () => {
    const porcelain = [
      `${A} 7 3 2`,
      "author Someone",
      "filename x.ts",
      "\tconst a = 1;",
      `${A} 8 4`,
      "\tconst b = 2;",
      `${B} 1 5 1`,
      "summary initial",
      "filename old/x.ts",
      "\treturn a;",
      `${A} 9 6`,
      "\treturn b;",
    ].join("\n");
    expect(parseBlame(porcelain, "x.ts")).toEqual([
      { commit: A, file: "x.ts", line: 7, text: "const a = 1;" },
      { commit: A, file: "x.ts", line: 8, text: "const b = 2;" },
      { commit: B, file: "old/x.ts", line: 1, text: "return a;" },
      { commit: A, file: "x.ts", line: 9, text: "return b;" },
    ]);
  });
});

describe("isTrivialLine", () => {
  it("knows lines without behaviour", () => {
    for (const t of ["", "   ", "}", "});", "// note", "# note", " * doc"]) {
      expect(isTrivialLine(t), t).toBe(true);
    }
    expect(isTrivialLine("return a + b;")).toBe(false);
  });
});

describe("claimsFrom", () => {
  const line = (commit: string, n: number, text = `x${n}`, file = "x.ts") => ({
    commit,
    file,
    line: n,
    text,
  });

  it("makes one claim per run of consecutive lines a commit introduced", () => {
    const blamed = [line(A, 4), line(A, 5), line(A, 9), line(B, 2), line(A, 6, "  }")];
    expect(claimsFrom(fix, blamed)).toEqual([
      { introduced: A, fix, file: "x.ts", lines: [4, 5] },
      { introduced: A, fix, file: "x.ts", lines: [9, 9] },
      { introduced: B, fix, file: "x.ts", lines: [2, 2] },
    ]);
  });

  it("names the file as the introducing commit had it, before a rename", () => {
    expect(claimsFrom(fix, [line(A, 3, "x3", "old.ts"), line(A, 4, "x4", "old.ts")])).toEqual([
      { introduced: A, fix, file: "old.ts", lines: [3, 4] },
    ]);
  });

  it("drops runs longer than a required claim and the fix's own lines", () => {
    const long = Array.from({ length: 16 }, (_, i) => line(A, i + 1));
    expect(claimsFrom(fix, [...long, line(F, 40)])).toEqual([]);
  });
});

describe("candidateCase", () => {
  const commit = {
    sha: A,
    parent: B,
    subject: "feat(core): bundle by directory",
    date: "2026-10-01",
    changedLines: 40,
  };
  const claim = (sha: string, file: string, lines: [number, number], subject = "fix: x") => ({
    introduced: A,
    fix: { sha, subject },
    file,
    lines,
  });

  it("writes one claim per fix with the fix's other places in also", () => {
    const c = candidateCase(
      commit,
      [claim(F, "src/b.ts", [10, 12]), claim(F, "src/a.ts", [3, 3])],
      { repo: "jma49/Open-CR-Agent", licence: "Apache-2.0" },
    ) as { id: string; expect: unknown[]; base: string; source: { kind: string } };
    expect(c.id).toBe(`fix-open-cr-agent-${A.slice(0, 12)}`);
    expect(c.base).toBe(B);
    expect(c.source.kind).toBe("github");
    expect(c.expect).toEqual([
      {
        id: "fix-1",
        file: "src/a.ts",
        lines: [3, 3],
        category: "correctness",
        minSeverity: "suggestion",
        concern: `Later fixed by ${F.slice(0, 12)}: fix: x`,
        also: [{ file: "src/b.ts", lines: [10, 12] }],
        origin: "author-fix",
        producer: "szz",
      },
    ]);
  });

  it("keeps at most three fixes, a security fix as security", () => {
    const shas = ["1", "2", "3", "4"].map((d) => d.repeat(40));
    const c = candidateCase(
      commit,
      shas.map((sha, i) =>
        claim(sha, "src/a.ts", [i + 1, i + 1], i === 0 ? "fix: path traversal" : "fix: y"),
      ),
      { repo: "o/r", licence: "NOASSERTION" },
    ) as { expect: { category: string }[] };
    expect(c.expect).toHaveLength(3);
    expect(c.expect[0]?.category).toBe("security");
  });
});
