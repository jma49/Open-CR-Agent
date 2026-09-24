import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./parse.js";

const fixture = readFileSync(new URL("./__fixtures__/git-staged.diff", import.meta.url), "utf8");

function byPath(path: string) {
  const file = parseUnifiedDiff(fixture).find((f) => f.newPath === path);
  if (!file) throw new Error(`missing ${path}`);
  return file;
}

describe("parseUnifiedDiff on real git output", () => {
  it("splits every file section in order", () => {
    expect(parseUnifiedDiff(fixture).map((f) => [f.newPath, f.kind])).toEqual([
      ["bin.dat", "modified"],
      ["crlf.txt", "modified"],
      ["del.txt", "deleted"],
      ["keep.txt", "modified"],
      ["mode.sh", "modified"],
      ["nonl.txt", "modified"],
      ["to dir.txt", "renamed"],
      ["文件 名.txt", "added"],
    ]);
  });

  it("marks binary files without hunks", () => {
    expect(byPath("bin.dat")).toMatchObject({ isBinary: true, hunks: [], additions: 0 });
  });

  it("numbers old and new lines and counts churn", () => {
    const keep = byPath("keep.txt");
    expect(keep).toMatchObject({ additions: 2, deletions: 1 });
    expect(keep.hunks[0]?.lines).toEqual([
      { kind: "context", content: "a", oldLine: 1, newLine: 1 },
      { kind: "delete", content: "b", oldLine: 2 },
      { kind: "add", content: "B", newLine: 2 },
      { kind: "context", content: "c", oldLine: 3, newLine: 3 },
      { kind: "add", content: "-- sql comment", newLine: 4 },
    ]);
  });

  it("drops carriage returns from CRLF content", () => {
    expect(byPath("crlf.txt").hunks[0]?.lines.map((l) => l.content)).toEqual(["x", "y", "Y"]);
  });

  it("ignores no-newline markers", () => {
    const nonl = byPath("nonl.txt");
    expect(nonl.hunks[0]?.lines.map((l) => l.kind)).toEqual(["delete", "add"]);
  });

  it("keeps deleted files under their old path", () => {
    expect(byPath("del.txt")).toMatchObject({ oldPath: "del.txt", deletions: 1, additions: 0 });
  });

  it("reads rename paths with spaces and trailing tab", () => {
    expect(byPath("to dir.txt")).toMatchObject({ oldPath: "from.txt", additions: 1, deletions: 1 });
  });

  it("decodes quoted UTF-8 paths", () => {
    expect(byPath("文件 名.txt")).toMatchObject({ oldPath: "文件 名.txt", additions: 1 });
  });

  it("treats mode-only changes as modified without hunks", () => {
    expect(byPath("mode.sh")).toMatchObject({ hunks: [], additions: 0, deletions: 0 });
  });
});

describe("parseUnifiedDiff edge cases", () => {
  it("parses a diff saved with CRLF line endings", () => {
    const text =
      "diff --git a/x.ts b/x.ts\r\n--- a/x.ts\r\n+++ b/x.ts\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n";
    const [file] = parseUnifiedDiff(text);
    expect(file).toMatchObject({ newPath: "x.ts", additions: 1, deletions: 1 });
  });

  it("does not mistake a removed '-- ' line for a file marker", () => {
    const text = [
      "diff --git a/q.sql b/q.sql",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,2 +1,1 @@",
      "--- drop me",
      " select 1;",
    ].join("\n");
    const [file] = parseUnifiedDiff(text);
    expect(file?.oldPath).toBe("q.sql");
    expect(file?.hunks[0]?.lines[0]).toEqual({ kind: "delete", content: "-- drop me", oldLine: 1 });
  });

  it("keeps the patch text of each section", () => {
    const [first] = parseUnifiedDiff(fixture);
    expect(first?.patch.split("\n")[0]).toBe("diff --git a/bin.dat b/bin.dat");
  });

  it("returns nothing for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
