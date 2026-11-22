import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../diff/parse.js";
import { changedRanges, insertDocComments, isDocComment, isSubsequence } from "./edits.js";

const block = { kind: "block" } as const;
const SOURCE = [
  "import { x } from './x';",
  "",
  "export function retry(limit: number) {",
  "  return limit > 0;",
  "}",
  "",
  "export const old = 1;",
  "",
].join("\n");
// Lines 3-5 changed; line 7 did not.
const RANGES = [{ from: 3, to: 5 }];

const doc = ["/**", " * Whether to retry.", " */"];

describe("insertDocComments", () => {
  it("inserts a comment before a changed declaration and keeps every line", () => {
    const result = insertDocComments("a.ts", SOURCE, [{ after: 2, lines: doc }], RANGES, block);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edit.content.split("\n").slice(2, 6)).toEqual([...doc, SOURCE.split("\n")[2]]);
    expect(isSubsequence(SOURCE.split("\n"), result.edit.content.split("\n"))).toBe(true);
  });

  it("refuses a comment outside the changed lines", () => {
    const result = insertDocComments("a.ts", SOURCE, [{ after: 6, lines: doc }], RANGES, block);
    expect(result).toEqual({ ok: false, reason: "line 6 is outside the changed lines" });
  });

  it("refuses the whole reply when one insertion is code, not a comment", () => {
    const result = insertDocComments(
      "a.ts",
      SOURCE,
      [
        { after: 2, lines: doc },
        { after: 3, lines: ["  limit = 0;"] },
      ],
      RANGES,
      block,
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses a comment that closes early to hide code after it", () => {
    const lines = ["/** Retries. */ process.exit(1); /**", " */"];
    const result = insertDocComments("a.ts", SOURCE, [{ after: 2, lines }], RANGES, block);
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses lines past the end, two comments at one place and continued lines", () => {
    const at = (after: number) =>
      insertDocComments("a.ts", SOURCE, [{ after, lines: doc }], [{ from: 1, to: 8 }], block);
    expect(at(7)).toMatchObject({ ok: false });
    expect(at(-1)).toMatchObject({ ok: false });
    expect(at(1.5)).toMatchObject({ ok: false });
    const twice = insertDocComments(
      "a.ts",
      SOURCE,
      [
        { after: 2, lines: doc },
        { after: 2, lines: doc },
      ],
      RANGES,
      block,
    );
    expect(twice).toMatchObject({ ok: false });
    const continued = "const s = 'a\\\n";
    const result = insertDocComments(
      "a.ts",
      `${continued}b';\n`,
      [{ after: 1, lines: doc }],
      [{ from: 1, to: 2 }],
      block,
    );
    expect(result).toMatchObject({ ok: false, reason: "line 1 continues on the next line" });
  });

  it("keeps CRLF line endings in what it inserts", () => {
    const crlf = SOURCE.replaceAll("\n", "\r\n");
    const result = insertDocComments("a.ts", crlf, [{ after: 2, lines: doc }], RANGES, block);
    expect(result.ok && result.edit.content).toContain("/**\r\n * Whether to retry.\r\n */\r\n");
  });
});

describe("isSubsequence", () => {
  it("holds only when every original line is still there, in order", () => {
    expect(isSubsequence(["a", "b"], ["a", "x", "b"])).toBe(true);
    expect(isSubsequence(["a", "b"], ["a", "x"])).toBe(false);
    expect(isSubsequence(["a", "b"], ["b", "a"])).toBe(false);
  });
});

describe("isDocComment", () => {
  it("takes each language's doc comment and nothing else", () => {
    expect(isDocComment(block, ["/** One line. */"])).toBe(true);
    expect(isDocComment(block, ["/**", " * x", "*/ code();"])).toBe(false);
    expect(isDocComment(block, ["/**/", "x"])).toBe(false);
    const go = { kind: "line", marker: "//" } as const;
    expect(isDocComment(go, ["// Retry does it.", "//"])).toBe(true);
    expect(isDocComment(go, ["//go:generate rm -rf /"])).toBe(false);
    const rust = { kind: "line", marker: "///" } as const;
    expect(isDocComment(rust, ["/// Retries."])).toBe(true);
    expect(isDocComment(rust, ["// Retries."])).toBe(false);
    const python = { kind: "python" } as const;
    expect(isDocComment(python, ['    """Retries."""'])).toBe(true);
    expect(isDocComment(python, ['"""a"""; import os'])).toBe(false);
    expect(isDocComment(python, ['"""a\\"""'])).toBe(false);
  });
});

describe("changedRanges", () => {
  it("is the new side's lines of each hunk", () => {
    const [diff] = parseUnifiedDiff(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -3,2 +3,3 @@",
        " a",
        "+b",
        " c",
        "@@ -20,1 +21,0 @@",
        "-gone",
      ].join("\n"),
    );
    expect(diff && changedRanges(diff)).toEqual([{ from: 3, to: 5 }]);
  });
});
