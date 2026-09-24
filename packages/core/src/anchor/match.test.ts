import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../diff/parse.js";
import { isWithinHunks, matchInContent, matchInHunks } from "./match.js";

const [diff] = parseUnifiedDiff(
  [
    "diff --git a/src/user.ts b/src/user.ts",
    "--- a/src/user.ts",
    "+++ b/src/user.ts",
    "@@ -10,4 +10,6 @@ export function load(id: string) {",
    "   const user = cache.get(id);",
    "-  return user;",
    "+  if (!user) {",
    "+    return db.find(id);",
    "+  }",
    "+  return user;",
    " }",
    "@@ -40,2 +42,2 @@",
    "   return user;",
    "-  // old",
    "+  // new",
  ].join("\n"),
);
if (!diff) throw new Error("fixture did not parse");

describe("matchInHunks", () => {
  it("matches a multi-line snippet ignoring indentation and spacing", () => {
    expect(matchInHunks(diff, "if (!user)   {\n return db.find(id);")).toEqual({
      start: 11,
      end: 12,
    });
  });

  it("prefers a match that touches added lines", () => {
    expect(matchInHunks(diff, "return user;")).toEqual({ start: 14, end: 14 });
  });

  it("falls back to a substring match for single-line snippets", () => {
    expect(matchInHunks(diff, "db.find(id)")).toEqual({ start: 12, end: 12 });
  });

  it("does not substring-match multi-line snippets", () => {
    expect(matchInHunks(diff, "db.find\n}")).toBeUndefined();
  });

  it("never matches deleted lines", () => {
    expect(matchInHunks(diff, "// old")).toBeUndefined();
  });

  it("does not match across separate hunks", () => {
    expect(matchInHunks(diff, "}\nreturn user;\n// new")).toBeUndefined();
  });

  it("ignores blank snippet lines", () => {
    expect(matchInHunks(diff, "\n  \n")).toBeUndefined();
    expect(matchInHunks(diff, "}\n\n")).toEqual({ start: 13, end: 13 });
  });
});

describe("matchInContent", () => {
  it("matches in full file content with CRLF endings", () => {
    expect(matchInContent("a\r\nb\r\n  c\r\n", "b\nc")).toEqual({ start: 2, end: 3 });
  });
});

describe("isWithinHunks", () => {
  it("accepts ranges inside a hunk's new side only", () => {
    expect(isWithinHunks(diff, { start: 10, end: 15 })).toBe(true);
    expect(isWithinHunks(diff, { start: 15, end: 16 })).toBe(false);
    expect(isWithinHunks(diff, { start: 43, end: 43 })).toBe(true);
  });
});
