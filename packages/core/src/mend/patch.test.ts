import { describe, expect, it } from "vitest";
import { applyHunks, composePatches, type ItemPatch } from "./patch.js";

const FILE = ["one", "two", "three", "four"].join("\n");
const heads = new Map([
  ["a.ts", FILE],
  ["b.ts", FILE],
]);
const limits = { files: 10, addedLines: 200 };

function patch(item: string, path: string, startLine: number, endLine: number, replacement = "x") {
  return { item, hunks: [{ path, startLine, endLine, replacement }] } satisfies ItemPatch;
}

describe("applyHunks", () => {
  it("replaces, grows and deletes lines without moving the other hunks", () => {
    const after = applyHunks(FILE, [
      { path: "a.ts", startLine: 1, endLine: 1, replacement: "ONE\nand a half" },
      { path: "a.ts", startLine: 3, endLine: 3, replacement: "" },
      { path: "a.ts", startLine: 4, endLine: 4, replacement: "FOUR" },
    ]);
    expect(after).toBe(["ONE", "and a half", "two", "FOUR"].join("\n"));
  });
});

describe("composePatches", () => {
  it("puts the patches of several items into one change per file", () => {
    const composed = composePatches(
      [
        patch("p1", "a.ts", 1, 1, "ONE"),
        patch("p2", "b.ts", 2, 2, "TWO"),
        patch("p3", "a.ts", 4, 4),
      ],
      heads,
      limits,
    );
    expect(composed.kept).toEqual(["p1", "p2", "p3"]);
    expect(composed.left).toEqual([]);
    expect(composed.changes).toEqual([
      { path: "a.ts", before: FILE, after: ["ONE", "two", "three", "x"].join("\n") },
      { path: "b.ts", before: FILE, after: ["one", "TWO", "three", "four"].join("\n") },
    ]);
  });

  it("leaves out a patch that touches lines an earlier one changes", () => {
    const composed = composePatches(
      [patch("p1", "a.ts", 1, 2), patch("p2", "a.ts", 2, 3), patch("p3", "b.ts", 2, 3)],
      heads,
      limits,
    );
    expect(composed.kept).toEqual(["p1", "p3"]);
    expect(composed.left).toEqual([{ item: "p2", reason: "overlap" }]);
  });

  it("leaves out what would take the round past its files or its added lines", () => {
    const tall = patch("p2", "a.ts", 3, 3, "a\nb\nc");
    expect(
      composePatches([patch("p1", "a.ts", 1, 1), tall], heads, { files: 10, addedLines: 3 }).left,
    ).toEqual([{ item: "p2", reason: "no_room" }]);
    const other = patch("p2", "b.ts", 1, 1);
    expect(
      composePatches([patch("p1", "a.ts", 1, 1), other], heads, { files: 1, addedLines: 9 }).left,
    ).toEqual([{ item: "p2", reason: "no_room" }]);
  });
});
