import { describe, expect, it } from "vitest";
import { parseHunks } from "./hunks.js";

describe("parseHunks", () => {
  it("parses header-less patches such as the GitHub API returns", () => {
    const patch = [
      "@@ -10,2 +10,3 @@ function f() {",
      " a",
      "+b",
      " c",
      "@@ -40 +41 @@",
      "-x",
      "+y",
    ];
    const hunks = parseHunks(patch);
    expect(hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [10, 2, 10, 3],
      [40, 1, 41, 1],
    ]);
    expect(hunks[0]?.lines[1]).toEqual({ kind: "add", content: "b", newLine: 11 });
    expect(hunks[1]?.lines).toEqual([
      { kind: "delete", content: "x", oldLine: 40 },
      { kind: "add", content: "y", newLine: 41 },
    ]);
  });

  it("stops at malformed lines instead of misnumbering", () => {
    const hunks = parseHunks(["@@ -1,2 +1,2 @@", " a", "garbage", " b"]);
    expect(hunks[0]?.lines).toHaveLength(1);
  });

  it("handles files created from nothing", () => {
    const [hunk] = parseHunks(["@@ -0,0 +1,2 @@", "+a", "+b"]);
    expect(hunk?.lines.map((l) => (l.kind === "add" ? l.newLine : -1))).toEqual([1, 2]);
  });
});
