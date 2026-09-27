import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../diff/parse.js";
import {
  exactMatchesInHunks,
  isWithinHunks,
  MIN_PARTIAL_QUOTE_CHARS,
  matchInContent,
  matchInHunks,
} from "./match.js";

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

const found = (start: number, end = start) => ({ kind: "found", range: { start, end } });
const none = { kind: "none" };
const ambiguous = { kind: "ambiguous" };

function added(...lines: string[]) {
  const [parsed] = parseUnifiedDiff(
    [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      `@@ -1 +1,${lines.length + 1} @@`,
      " start();",
      ...lines.map((l) => `+${l}`),
    ].join("\n"),
  );
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
}

describe("matchInHunks", () => {
  it("matches a multi-line snippet ignoring indentation and spacing", () => {
    expect(matchInHunks(diff, "if (!user)   {\n return db.find(id);")).toEqual(found(11, 12));
  });

  it("prefers a match that touches added lines", () => {
    expect(matchInHunks(diff, "return user;")).toEqual(found(14));
  });

  it("matches part of a single line only when the part is long enough", () => {
    expect(MIN_PARTIAL_QUOTE_CHARS).toBe(12);
    expect(matchInHunks(diff, "return db.find(id)")).toEqual(found(12));
    expect(matchInHunks(diff, "db.find(id)")).toEqual(none);
    expect(matchInHunks(added("if (err) throw err;"), "err")).toEqual(none);
  });

  it("matches part of a line only when exactly one line contains it", () => {
    const diff = added("logger.warn(message1);", "logger.warn(message2);");
    expect(matchInHunks(diff, "logger.warn(message")).toEqual(none);
    expect(matchInHunks(diff, "logger.warn(message2")).toEqual(found(3));
  });

  it("calls several equally good whole-line matches ambiguous", () => {
    const diff = added("return err;", "cleanup();", "return err;");
    expect(matchInHunks(diff, "return err;")).toEqual(ambiguous);
    expect(matchInHunks(diff, "cleanup();\nreturn err;")).toEqual(found(3, 4));
  });

  it("does not substring-match multi-line snippets", () => {
    expect(matchInHunks(diff, "db.find\n}")).toEqual(none);
  });

  it("never matches deleted lines", () => {
    expect(matchInHunks(diff, "// old")).toEqual(none);
  });

  it("does not match across separate hunks", () => {
    expect(matchInHunks(diff, "}\nreturn user;\n// new")).toEqual(none);
  });

  it("ignores blank snippet lines", () => {
    expect(matchInHunks(diff, "\n  \n")).toEqual(none);
    expect(matchInHunks(diff, "}\n\n")).toEqual(found(13));
  });
});

describe("matchInContent", () => {
  it("matches in full file content with CRLF endings", () => {
    expect(matchInContent("a\r\nb\r\n  c\r\n", "b\nc")).toEqual(found(2, 3));
  });

  it("calls repeated lines ambiguous", () => {
    expect(matchInContent("return err;\nx\nreturn err;\n", "return err;")).toEqual(ambiguous);
  });
});

describe("exactMatchesInHunks", () => {
  it("finds only whole-line matches, in every file given", () => {
    const one = added("runTask(spec);");
    const two = { ...added("runTask(spec);", "runTaskLater(spec, 5);"), newPath: "y.ts" };
    expect(exactMatchesInHunks([one, two], "runTask(spec);")).toEqual([
      { file: "x.ts", range: { start: 2, end: 2 } },
      { file: "y.ts", range: { start: 2, end: 2 } },
    ]);
    expect(exactMatchesInHunks([two], "runTaskLater(spec")).toEqual([]);
  });
});

describe("isWithinHunks", () => {
  it("accepts ranges inside a hunk's new side only", () => {
    expect(isWithinHunks(diff, { start: 10, end: 15 })).toBe(true);
    expect(isWithinHunks(diff, { start: 15, end: 16 })).toBe(false);
    expect(isWithinHunks(diff, { start: 43, end: 43 })).toBe(true);
  });
});
